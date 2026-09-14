import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import solc from 'solc';
import {encodeFunctionData,type Abi} from 'viem';
import {settlementAbi} from '../src/settlement/model.js';

describe('AfridictSettlement contract boundary',()=>{
  it('compiles without errors and keeps backend calldata aligned with the deployed ABI',()=>{
    const source=readFileSync(new URL('../contracts/AfridictSettlement.sol',import.meta.url),'utf8');
    const output=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'AfridictSettlement.sol':{content:source}},
      settings:{optimizer:{enabled:true,runs:200},outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}}))) as {
        errors?:{severity:string;formattedMessage:string}[];contracts:Record<string,Record<string,{abi:Abi;evm:{bytecode:{object:string}}}>>};
    expect(output.errors?.filter(error=>error.severity==='error').map(error=>error.formattedMessage)??[]).toEqual([]);
    const contract=output.contracts['AfridictSettlement.sol']?.AfridictSettlement;
    expect(contract?.evm.bytecode.object.length).toBeGreaterThan(1000);
    const args=[`0x${'1'.repeat(64)}`,`0x${'2'.repeat(64)}`,`0x${'3'.repeat(64)}`,
      `0x${'4'.repeat(64)}`,100n,2n] as const;
    const compiled=encodeFunctionData({abi:contract!.abi,functionName:'commitBatch',args});
    const backend=encodeFunctionData({abi:settlementAbi,functionName:'commitBatch',args});
    expect(backend).toBe(compiled);
  });
});
