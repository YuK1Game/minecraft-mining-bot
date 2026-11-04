'use strict'
// Future stable-layer QA. All watched files are in owned OS.TEMP directories.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),{setTimeout:delay}=require('node:timers/promises')
const root=process.env.HOTRELOAD_TEST_ROOT??process.cwd(),canonical=path.join(root,'src/hotreload.js'),loaded=new Module(canonical,module)
loaded.filename=canonical;loaded.paths=Module._nodeModulePaths(path.dirname(canonical));loaded._compile(fs.readFileSync(process.env.HOTRELOAD_TEST_SOURCE??canonical,'utf8'),canonical)
const {createHotReloader}=loaded.exports
async function until(check,label='owned watcher condition',ms=1500){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await delay(5)}assert.fail(label)}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}}
function workspace(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mc-content-filter-')),created=new Set(),managers=[],errors=[],events=[],client={identity:'controlled-stable-client',connected:true},context={client,events,construct:null}
 let notices=0;const observer=fs.watch(directory,()=>{notices++})
 function write(name,text){const file=path.resolve(directory,name);assert.equal(path.dirname(file),directory);created.add(file);fs.writeFileSync(file,text);return file}
 const helper=write('helper.js','exports.value=1\n'),stable=write('world.js','exports.marker="original-stable"\n')
 const entry=write('behavior.js',"const helper=require('./helper'),stable=require('./world');exports.createRuntime=async context=>{if(context.construct)await context.construct(helper.value);return{value:helper.value,client:context.client,stable,dispose(reason){context.events.push('dispose:'+helper.value+':'+reason)}}}\n")
 function manager(options={}){const actor=createHotReloader({entry,watchFiles:[helper],createContext:()=>context,onSwap:next=>events.push('swap:'+next.value),onError:e=>errors.push(e.message),debounceMs:20,pollMs:5,maxWaitMs:600,...options});managers.push(actor);return actor}
 async function noticed(before){await until(()=>notices>before,'owned fs.watch did not observe the write');await delay(65)}
 t.after(async()=>{
  for(const actor of managers)actor.stop();observer.close();await until(()=>managers.every(actor=>!actor.snapshot().pending),'owned reload did not drain after its watcher stop',600)
  for(const actor of managers)if(actor.current)await actor.current.dispose('owned_test_end')
  const actual=fs.realpathSync(directory),tempRoot=path.resolve(os.tmpdir())+path.sep
  assert.ok(actual.toLowerCase().startsWith(tempRoot.toLowerCase()));assert.ok(path.basename(actual).startsWith('mc-content-filter-'))
  for(const file of created){assert.equal(path.dirname(file),directory);delete require.cache[file];try{fs.unlinkSync(file)}catch(e){if(e.code!=='ENOENT')throw e}}
  fs.rmdirSync(directory)
 })
 return{directory,entry,helper,stable,client,context,events,errors,write,manager,noticed,notices:()=>notices}
}

test('unchanged byte saves, metadata and duplicate watch events never dispose or increment generation; explicit same-source reload still uses physical gates',async t=>{
 const f=workspace(t);let safe=true;const m=f.manager({canReload:()=>safe});await m.loadInitial();m.watch();const first=m.current,loadedAt=m.snapshot().lastReload
 safe=false
 let count=f.notices();f.write('helper.js','exports.value=1\n');await f.noticed(count)
 count=f.notices();const now=new Date();fs.utimesSync(f.helper,now,now);await f.noticed(count)
 count=f.notices();for(let n=0;n<4;n++)f.write('helper.js','exports.value=1\n');await f.noticed(count)
 assert.strictEqual(m.current,first);assert.equal(m.snapshot().generation,1);assert.equal(m.snapshot().pending,false);assert.deepEqual(m.snapshot().lastReload,loadedAt);assert.deepEqual(f.events,['swap:1']);assert.deepEqual(f.errors,[])
 const manual=m.reload({reason:'source_saved'});await delay(25);assert.equal(m.snapshot().pending,true);assert.strictEqual(m.current,first);safe=true;await manual
 assert.equal(m.snapshot().generation,2);assert.notStrictEqual(m.current,first);assert.strictEqual(m.current.client,f.client);assert.deepEqual(f.events,['swap:1','dispose:1:hot_reload','swap:1'])
})

test('atomic replacement compares content while protected stable-module cache remains outside the behavior boundary',async t=>{
 const f=workspace(t),m=f.manager();await m.loadInitial();m.watch();const first=m.current,stableCache=require.cache[f.stable]
 let count=f.notices();const same=f.write('same-replacement.js','exports.value=1\n');fs.renameSync(same,f.helper);await f.noticed(count)
 assert.strictEqual(m.current,first);assert.equal(m.snapshot().generation,1);assert.deepEqual(f.events,['swap:1'])
 count=f.notices();f.write('world.js','exports.marker="stable-disk-change"\n');await f.noticed(count);assert.strictEqual(m.current,first);assert.ok(!m.snapshot().watchFiles.includes(f.stable))
 const changed=f.write('changed-replacement.js','exports.value=2\n');fs.renameSync(changed,f.helper);await until(()=>m.current.value===2,'changed atomic replacement was missed')
 assert.equal(m.snapshot().generation,2);assert.strictEqual(require.cache[f.stable],stableCache);assert.strictEqual(m.current.stable,first.stable);assert.equal(m.current.stable.marker,'original-stable');assert.strictEqual(m.current.client,first.client)
})

test('failed syntax never becomes the successful fingerprint: unchanged bad content retries, and its corrected version loads without disposing the old runtime early',async t=>{
 const f=workspace(t),m=f.manager();await m.loadInitial();m.watch();const first=m.current
 f.write('helper.js','exports.value=(\n');await until(()=>f.errors.length===1&&!m.snapshot().pending,'syntax error was not reported');assert.strictEqual(m.current,first);assert.deepEqual(f.events,['swap:1']);assert.equal(m.snapshot().generation,1)
 f.write('helper.js','exports.value=(\n');await until(()=>f.errors.length>=2&&!m.snapshot().pending,'same still-invalid source was incorrectly marked loaded');assert.strictEqual(m.current,first)
 f.write('helper.js','exports.value=2\n');await until(()=>m.current.value===2,'corrected source was missed');assert.equal(m.snapshot().generation,2);assert.deepEqual(f.events,['swap:1','dispose:1:hot_reload','swap:2']);assert.equal(f.client.connected,true)
})

test('new dependency versions and source changes during passive construction are rebuilt before active disposal',async t=>{
 const f=workspace(t),m=f.manager();await m.loadInitial();m.watch()
 const extra=f.write('extra.js','exports.value=2\n');f.write('behavior.js',"const helper=require('./extra'),stable=require('./world');exports.createRuntime=async context=>{if(context.construct)await context.construct(helper.value);return{value:helper.value,client:context.client,stable,dispose(reason){context.events.push('dispose:'+helper.value+':'+reason)}}}\n")
 await until(()=>m.current.value===2,'new dependency entry was missed');assert.ok(m.snapshot().watchFiles.includes(extra));assert.equal(m.snapshot().generation,2)
 f.write('extra.js','exports.value=3\n');await until(()=>m.current.value===3,'discovered dependency change was missed');assert.equal(m.snapshot().generation,3)
 let changed=false;f.context.construct=value=>{if(value===4&&!changed){changed=true;f.write('extra.js','exports.value=5\n')}}
 f.write('extra.js','exports.value=4\n');await until(()=>m.current.value===5,'latest construction-time source was missed');assert.ok(!f.events.includes('swap:4'),'unstable passive candidate must never be activated');assert.equal(f.events.filter(e=>e==='dispose:3:hot_reload').length,1);assert.strictEqual(m.current.client,f.client)
 const generation=m.snapshot().generation;await delay(70);assert.equal(m.snapshot().generation,generation,'duplicate pending event must not reload the already loaded final version')
})

test('source changes during the second physical gate or activation are not mistaken for the version actually loaded',async t=>{
 await t.test('second safe point revalidates bytes before disposing the old runtime',async t=>{
  const f=workspace(t);let safe=true,constructed=false;const m=f.manager({canReload:()=>safe});await m.loadInitial();m.watch();const first=m.current
  f.context.construct=value=>{if(value===2){safe=false;constructed=true}}
  f.write('helper.js','exports.value=2\n');await until(()=>constructed,'owned passive candidate was never constructed');await delay(20);assert.strictEqual(m.current,first);assert.deepEqual(f.events,['swap:1'])
  f.write('helper.js','exports.value=3\n');safe=true;await until(()=>m.current.value===3,'latest second-gate version was missed');assert.ok(!f.events.includes('swap:2'));assert.equal(f.events.filter(e=>e==='dispose:1:hot_reload').length,1);assert.strictEqual(m.current.client,f.client)
 })
 await t.test('activation-time source is followed by its genuine version, not fingerprinted as already loaded',async t=>{
  const f=workspace(t);let changed=false;const m=f.manager({onSwap:async next=>{f.events.push('swap:'+next.value);if(next.value===2&&!changed){changed=true;f.write('helper.js','exports.value=3\n');await delay(5)}}});await m.loadInitial();m.watch()
  f.write('helper.js','exports.value=2\n');await until(()=>m.current.value===3,'activation-time final version was missed');assert.ok(f.events.includes('swap:2'));assert.ok(f.events.includes('swap:3'));assert.strictEqual(m.current.client,f.client)
  const generation=m.snapshot().generation;await delay(70);assert.equal(m.snapshot().generation,generation)
 })
})
