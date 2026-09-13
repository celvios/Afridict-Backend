// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20SettlementAsset {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

/// @notice Collateral-backed, immutable settlement batches for finalized Afridict markets.
/// @dev Leaves are sha256(abi.encodePacked(batchId,index,recipient,amount)).
contract AfridictSettlement {
    struct Batch {
        bytes32 marketId;
        bytes32 resolutionHash;
        bytes32 merkleRoot;
        uint256 total;
        uint256 itemCount;
        uint256 claimed;
    }

    IERC20SettlementAsset public immutable collateral;
    address public immutable operator;
    address public immutable guardian;
    bool public paused;
    uint256 public outstandingLiability;
    mapping(bytes32 => Batch) public batches;
    mapping(bytes32 => mapping(uint256 => uint256)) private claimedBitmaps;

    event BatchCommitted(bytes32 indexed batchId, bytes32 indexed marketId, bytes32 indexed resolutionHash,
        bytes32 merkleRoot, uint256 total, uint256 itemCount);
    event Claimed(bytes32 indexed batchId, uint256 indexed index, address indexed recipient, uint256 amount);
    event PauseChanged(bool paused);

    error Unauthorized();
    error Paused();
    error InvalidBatch();
    error InsufficientCollateral();
    error AlreadyClaimed();
    error InvalidProof();
    error TransferFailed();

    constructor(address collateral_, address operator_, address guardian_) {
        if (collateral_ == address(0) || operator_ == address(0) || guardian_ == address(0) || operator_ == guardian_)
            revert InvalidBatch();
        collateral = IERC20SettlementAsset(collateral_);
        operator = operator_;
        guardian = guardian_;
    }

    function setPaused(bool value) external {
        if (msg.sender != guardian) revert Unauthorized();
        paused = value;
        emit PauseChanged(value);
    }

    function commitBatch(bytes32 batchId, bytes32 marketId, bytes32 resolutionHash, bytes32 merkleRoot,
        uint256 total, uint256 itemCount) external {
        if (msg.sender != operator) revert Unauthorized();
        if (paused) revert Paused();
        if (batchId == bytes32(0) || marketId == bytes32(0) || resolutionHash == bytes32(0) ||
            merkleRoot == bytes32(0) || total == 0 || itemCount == 0 || itemCount > 100 ||
            batches[batchId].merkleRoot != bytes32(0)) revert InvalidBatch();
        uint256 nextLiability = outstandingLiability + total;
        if (collateral.balanceOf(address(this)) < nextLiability) revert InsufficientCollateral();
        outstandingLiability = nextLiability;
        batches[batchId] = Batch(marketId, resolutionHash, merkleRoot, total, itemCount, 0);
        emit BatchCommitted(batchId, marketId, resolutionHash, merkleRoot, total, itemCount);
    }

    function claim(bytes32 batchId, uint256 index, address recipient, uint256 amount,
        bytes32[] calldata proof) external {
        if (paused) revert Paused();
        Batch storage batch = batches[batchId];
        if (batch.merkleRoot == bytes32(0) || index >= batch.itemCount || recipient == address(0) || amount == 0)
            revert InvalidBatch();
        uint256 word = index >> 8;
        uint256 mask = 1 << (index & 255);
        if (claimedBitmaps[batchId][word] & mask != 0) revert AlreadyClaimed();
        bytes32 node = sha256(abi.encodePacked(batchId, index, recipient, amount));
        for (uint256 i = 0; i < proof.length; ++i) {
            bytes32 sibling = proof[i];
            node = node < sibling ? sha256(abi.encodePacked(node, sibling)) : sha256(abi.encodePacked(sibling, node));
        }
        if (node != batch.merkleRoot) revert InvalidProof();
        if (batch.claimed + amount > batch.total) revert InvalidBatch();
        claimedBitmaps[batchId][word] |= mask;
        batch.claimed += amount;
        outstandingLiability -= amount;
        if (!collateral.transfer(recipient, amount)) revert TransferFailed();
        emit Claimed(batchId, index, recipient, amount);
    }

    function isClaimed(bytes32 batchId, uint256 index) external view returns (bool) {
        return claimedBitmaps[batchId][index >> 8] & (1 << (index & 255)) != 0;
    }
}
