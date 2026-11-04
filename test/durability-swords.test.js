'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),{createDurabilityReader}=require('../src/durability'),fixture=require('./fixtures/actual-wooden-sword-damage10.json'),read=createDurabilityReader()
test('Actual Realm wooden sword stack1721 Damage10 is parsed without changing the descriptor or raw receipt',()=>{
 const before=structuredClone(fixture),value=read(fixture.description,fixture.raw)
 assert.equal(value.durabilityKnown,true);assert.equal(value.stackId,1721);assert.equal(value.durabilityUsed,10);assert.equal(value.maxDurability,59);assert.equal(value.durabilityRemaining,49);assert.equal(value.durabilitySource,'server_item_nbt');assert.deepEqual(fixture,before)
})
test('Sword durability rejects null, wrong count, absent/zero stack ID, mismatched stack ID and wrong item identity',()=>{
 const description={...fixture.description,stackId:1721}
 for(const raw of [null,{...fixture.raw,count:2},{...fixture.raw,has_stack_id:false},{...fixture.raw,stack_id:0},{...fixture.raw,stack_id:1722},{...fixture.raw,network_id:312}])assert.equal(read(description,raw).durabilityKnown,false)
})
test('Unknown/malformed sword NBT cannot be promoted to fresh durability; metadata does not override actual NBT',()=>{
 for(const extra of [undefined,{}, {has_nbt:true}, {has_nbt:true,nbt:{version:1,nbt:{type:'compound',name:'',value:{}}}}, {has_nbt:true,nbt:{version:1,nbt:{type:'compound',name:'',value:{Damage:{type:'string',value:'10'}}}}}])assert.equal(read(fixture.description,{...fixture.raw,extra}).durabilityKnown,false)
 const raw=structuredClone(fixture.raw);raw.metadata=58;assert.equal(read(fixture.description,raw).durabilityUsed,10)
 raw.extra.nbt.nbt.value.Damage.value=60;assert.equal(read(fixture.description,raw).durabilityKnown,false)
 raw.extra.nbt.nbt.value.Damage.value=59;assert.equal(read(fixture.description,raw).durabilityRemaining,0)
})
