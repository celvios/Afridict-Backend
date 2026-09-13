import {createPublicClient,http,keccak256,sha256,type Address,type Hex} from 'viem';
import type {SettlementObservation,SettlementObserver} from './service.js';

const networks={
  46630:{name:'Robinhood Chain Testnet',rpc:'https://rpc.testnet.chain.robinhood.com'},
  4663:{name:'Robinhood Chain',rpc:'https://rpc.mainnet.chain.robinhood.com'},
} as const;

export class RobinhoodRpcObserver implements SettlementObserver {
  readonly id:string;
  private readonly endpoint:URL;
  constructor(id:string,endpoint:string){
    if(!/^[A-Za-z0-9._-]{1,80}$/.test(id))throw new Error('Invalid settlement observer identity');
    const url=new URL(endpoint);if(url.protocol!=='https:')throw new Error('Settlement RPC endpoints must use HTTPS');
    this.id=id;this.endpoint=url;
  }
  async observe(chainId:number,transactionHash:Hex):Promise<SettlementObservation|null>{
    const network=networks[chainId as keyof typeof networks];if(!network)throw new Error('Unsupported Robinhood Chain ID');
    const chain={id:chainId,name:network.name,nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},
      rpcUrls:{default:{http:[this.endpoint.toString()]}}};
    const client=createPublicClient({chain,transport:http(this.endpoint.toString(),{timeout:8000,retryCount:1})});
    const observedChainId=await client.getChainId();if(observedChainId!==chainId)throw new Error('Settlement RPC returned the wrong chain ID');
    const transaction=await client.getTransaction({hash:transactionHash}).catch(error=>{
      if((error as {name?:string}).name==='TransactionNotFoundError')return null;throw error;});
    if(!transaction||transaction.blockNumber===null||!transaction.blockHash)return null;
    const [receipt,head,bytecode]=await Promise.all([client.getTransactionReceipt({hash:transactionHash}),
      client.getBlockNumber(),client.getBytecode({address:transaction.to as Address,blockNumber:transaction.blockNumber})]);
    if(!transaction.to||!bytecode)throw new Error('Settlement transaction target has no deployed code');
    return {transactionHash,blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,headNumber:head,
      contractAddress:transaction.to.toLowerCase() as Address,calldataHash:sha256(transaction.input),
      receiptSuccess:receipt.status==='success',contractCodeHash:keccak256(bytecode)};
  }
}
