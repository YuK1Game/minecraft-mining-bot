'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const fixture=require('./fixtures/foraging-received-corner-drops.json')
function probe (blocks,source=fs.readFileSync(path.resolve(__dirname,'../src/foraging.js'),'utf8')) {
 const needle='return { preview, execute, stop, snapshot }'
 assert.equal(source.split(needle).length,2,'Private test probe must match one controller return')
 const filename=path.resolve(process.cwd(),'src/foraging.js'),mod=new Module(filename,module);mod.filename=filename;mod.paths=Module._nodeModulePaths(path.dirname(filename));mod._compile(source.replace(needle,'return { preview, execute, stop, snapshot, candidateProbe: candidates, stanceProbe: safeStance }'),filename)
 const map=new Map(blocks.map(b=>[[b.position.x,b.position.y,b.position.z].join(','),b])),world={getBlock:(x,y,z)=>map.get([x,y,z].join(','))??{known:false,position:{x,y,z}}},never=()=>{throw Error('This offline candidate test must not execute an action')}
 return mod.exports.createForaging({getState:never,world,entities:{snapshot:never},movement:{preview:never,start:never,stop:never},getMovement:never,combat:{previewHunt:never,hunt:never,cancel:never}})
}
const legacy=[[0,0],[.4,0],[-.4,0],[0,.4],[0,-.4]]
for(const c of fixture.cases)test(c.label+' actual received corner has a safe diagonal absent from the old cross',()=>{
 const p=probe(c.blocks),feet=Math.floor(c.item.y),cross=legacy.map(([dx,dz])=>({x:c.item.x+dx,y:feet,z:c.item.z+dz}))
 assert(cross.every(v=>!p.stanceProbe(v)),'Every original cross position must fail its unchanged full footprint/body check')
 const point={x:c.item.x-.4,y:feet,z:c.item.z+(c.item.z%1>.5?-.4:.4)}
 assert.equal(p.stanceProbe(point),true,'The received in-cell diagonal must retain known floor/body/head support')
 // This synthetic close observer is candidate-classification input only; it is
 // not an assertion about the historical Realm player or any movement receipt.
 const candidates=p.candidateProbe({position:{x:c.item.x,y:feet+1.62,z:c.item.z+2}},c.item,'drop',new Set())
 assert(candidates.some(v=>Math.abs(v.position.x-point.x)<1e-8&&Math.abs(v.position.z-point.z)<1e-8&&v.position.y===feet),'The real candidate function must emit the supported diagonal')
 assert(candidates.every(v=>Math.hypot(v.position.x-c.item.x,v.position.z-c.item.z)<=.8),'Existing body-range bound remains unchanged')
})
test('Actual mutton corner diagonal still rejects unknown support, liquid, leaves and protected floor',()=>{
 const c=fixture.cases[1],x=Math.floor(c.item.x),z=Math.floor(c.item.z),y=Math.floor(c.item.y),point={x:c.item.x-.4,y,z:c.item.z-.4}
 for(const [label,where,patch]of[['unknown floor',{x,y:y-1,z},{known:false}],['water floor',{x,y:y-1,z},{name:'minecraft:water',boundingBox:'empty'}],['protected floor',{x,y:y-1,z},{protected:true}],['leaves head',{x,y:y+1,z},{name:'minecraft:oak_leaves',boundingBox:'block'}],['unknown head',{x,y:y+1,z},{known:false}]]){
  const blocks=structuredClone(c.blocks),target=blocks.find(b=>['x','y','z'].every(k=>b.position[k]===where[k]));assert(target);Object.assign(target,patch);assert.equal(probe(blocks).stanceProbe(point),false,label)
 }
})
