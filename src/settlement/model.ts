import { concatHex,encodeFunctionData,encodePacked,sha256,stringToHex,type Address,type Hex } from 'viem';
import { canonical,hash } from '../platform/commands.js';

export const settlementAbi=[{
  type:'function',name:'commitBatch',stateMutability:'nonpayable',inputs:[
    {name:'batchId',type:'bytes32'},{name:'marketId',type:'bytes32'},{name:'resolutionHash',type:'bytes32'},
    {name:'merkleRoot',type:'bytes32'},{name:'total',type:'uint256'},{name:'itemCount',type:'uint256'},
  ],outputs:[],
}] as const;

export interface SettlementPayout {fillId:string;side:'buyer'|'seller';ownerId:string;recipient:Address;amount:bigint}
export interface SettlementLeaf extends SettlementPayout {index:number;leafHash:Hex;proof:Hex[]}

export const settlementKey=(value:string)=>sha256(stringToHex(value));
export function buildSettlementManifest(batchId:string,marketId:string,resolutionHash:string,payouts:SettlementPayout[]){
  if(!payouts.length||payouts.length>100)throw new Error('A settlement batch requires between 1 and 100 payouts');
  const batchKey=settlementKey(batchId),marketKey=settlementKey(marketId);
  const leaves=payouts.map((p,index)=>sha256(encodePacked(['bytes32','uint256','address','uint256'],
    [batchKey,BigInt(index),p.recipient,p.amount])));
  let level=leaves.slice();const proofs=leaves.map(()=>[] as Hex[]);
  let memberships=leaves.map((_,index)=>[index]);
  while(level.length>1){
    const next:Hex[]=[],nextMemberships:number[][]=[];
    for(let i=0;i<level.length;i+=2){
      const left=level[i]!,right=level[i+1]??left;
      for(const member of memberships[i]!)proofs[member]!.push(right);
      if(i+1<level.length)for(const member of memberships[i+1]!)proofs[member]!.push(left);
      const pair=left.toLowerCase()<right.toLowerCase()?[left,right]:[right,left];
      next.push(sha256(concatHex(pair)));nextMemberships.push([...memberships[i]!,...(memberships[i+1]??[])]);
    }
    level=next;memberships=nextMemberships;
  }
  const items:SettlementLeaf[]=payouts.map((p,index)=>({...p,index,leafHash:leaves[index]!,proof:proofs[index]!}));
  const total=payouts.reduce((sum,p)=>sum+p.amount,0n),merkleRoot=level[0]!;
  const manifestHash=hash({batch_id:batchId,market_id:marketId,resolution_hash:resolutionHash,
    merkle_root:merkleRoot,total_minor:total.toString(),items:items.map(i=>({index:i.index,fill_id:i.fillId,
      side:i.side,owner_id:i.ownerId,recipient:i.recipient,amount_minor:i.amount.toString(),leaf_hash:i.leafHash}))});
  const calldata=encodeFunctionData({abi:settlementAbi,functionName:'commitBatch',args:[batchKey,marketKey,
    `0x${resolutionHash}` as Hex,merkleRoot,total,BigInt(items.length)]});
  return {batchKey,marketKey,items,total,merkleRoot,manifestHash,calldata,calldataHash:sha256(calldata),
    canonicalManifest:canonical({batch_id:batchId,market_id:marketId,resolution_hash:resolutionHash,
      merkle_root:merkleRoot,total_minor:total.toString(),item_count:items.length})};
}

export function verifySettlementProof(batchId:string,item:Pick<SettlementLeaf,'index'|'recipient'|'amount'|'proof'>,root:Hex){
  let node=sha256(encodePacked(['bytes32','uint256','address','uint256'],
    [settlementKey(batchId),BigInt(item.index),item.recipient,item.amount]));
  for(const sibling of item.proof){
    const pair=node.toLowerCase()<sibling.toLowerCase()?[node,sibling]:[sibling,node];node=sha256(concatHex(pair));
  }
  return node===root;
}
