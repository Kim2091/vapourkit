import { describe, it, expect } from 'vitest';
import { rgbChainBoundaries } from './aiChainPlan';
const ai=(id:string)=>({id,filterType:'aiModel',modelPath:id+'.onnx',enabled:true});
describe('RGB chaining boundaries',()=>{
  it('keeps only adjacent, enabled model edges in the same chain',()=>{
    const custom={id:'custom',filterType:'custom',enabled:true};
    expect([...rgbChainBoundaries([[ai('a'),ai('b'),custom,ai('c')],[ai('d')]],new Set())]).toEqual(['a']);
  });
  it('preserves retained stage references and the chain output',()=>{
    expect([...rgbChainBoundaries([[ai('a'),ai('b'),ai('c')]],new Set(['a']))]).toEqual(['b']);
    expect([...rgbChainBoundaries([[ai('a'),{...ai('b'),enabled:false},ai('c')]],new Set())]).toEqual(['a']);
  });
});
