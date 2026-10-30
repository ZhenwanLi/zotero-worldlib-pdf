const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('../src/site.js');
const Core = require('../src/core.js');

const identity = { unionid: 'test-account' };
const session = { identity, account: 'test-fingerprint' };
const stamp = () => {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const row = extra => ({ id: '123', title: '10.1016/j.example.2026.123',
  status: '应助完成', url: 'https://research.worldlib.site/tools/submit_ajax.ashx?action=getdownfile&path=/example.pdf',
  add_time: stamp(), replay: '', ...extra });
function setup(recent, historical = [], legacy = []) {
  const calls = [];
  const client = new Client({ getIdentity: () => identity, request: async (method, url, body) => {
    calls.push({ method, url, body });
    if (url.includes('getpersondoc_new')) return JSON.stringify(new URLSearchParams(body).get('ishistory') === '0' ? recent : historical);
    return JSON.stringify({ status: 0, data: legacy });
  }});
  return { client, calls };
}
test('queries recent results first without loading historical data or old messages', async () => {
  const { client, calls } = setup([row()], [], [{ id: '999', msgtype: 2, msgjson: {
    articleid: '123', xuqiuneirong: row().title, chulizhuangtai: '处理中' } }]);
  const result = await client.history(session);
  assert.equal(result.complete, true);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].complete, true);
  assert.deepEqual(result.records[0].dois, [row().title]);
  assert.equal(calls.length, 1);
  assert.equal(new URLSearchParams(calls[0].body).get('ishistory'), '0');
  assert.equal(new URLSearchParams(calls[0].body).get('uid'), identity.unionid);
  assert.equal(new URLSearchParams(calls[0].body).get('isread'), '2');
});
test('pending records are not completed even when a link is present', async () => {
  const { client } = setup([row({status: '应助中'})]);
  assert.equal((await client.results(session))[0].complete, false);
});
test('expired links and unverifiable timestamps are not downloaded', async () => {
  const { client } = setup([row({add_time:'2020/01/01 00:00:00'}), row({id:'124',add_time:''})]);
  for (const r of await client.results(session)) {
    assert.deepEqual(r.links, []);
    assert.match(r.reason, /24 小时/);
  }
});
test('NPC links require the default HTTPS port and are resolved to the account endpoint', async () => {
  const { client } = setup([row({url:'https://npc1.worldlib.site:8123/upload/example.pdf'})]);
  assert.deepEqual((await client.results(session))[0].links, []);
  const second = setup([row({url:'https://npc1.worldlib.site/upload/example.pdf'})]);
  const url = new URL((await second.client.results(session))[0].links[0]);
  assert.equal(url.searchParams.get('action'), 'getdownfile');
  assert.equal(url.searchParams.get('path'), '/upload/example.pdf');
});

test('download URLs reject untrusted hosts, local addresses, credentials and HTTP', async () => {
  const {client} = setup([]);
  for (const url of ['http://research.worldlib.site/file.pdf', 'https://127.0.0.1/file.pdf',
    'https://[::1]/file.pdf', 'https://192.168.1.1/file.pdf', 'https://example.org/file.pdf',
    'https://research.worldlib.site.evil.example/file.pdf',
    'https://user:password@research.worldlib.site/file.pdf', 'file:///example.pdf']) {
    assert.equal(Core.isSafeDownloadURL(url), false);
    await assert.rejects(client.downloadLinks(url), e => e.code === 'invalid_pdf');
  }
  assert.equal(Core.isSafeDownloadURL('https://npc1.worldlib.site/file.pdf'), true);
});

test('landing page links are filtered before being passed to the downloader', async () => {
  const client = new Client({request: async () => '<html></html>'});
  const anchor = href => ({textContent:'文件下载',getAttribute:()=>href});
  const page = links => () => ({querySelectorAll:()=>links.map(anchor)});
  const source = 'https://research.worldlib.site/tools/submit_ajax.ashx?action=getdownfile';
  await assert.rejects(client.downloadLinks(source, page(['http://127.0.0.1/private'])), e => e.code === 'invalid_pdf');
  assert.deepEqual(await client.downloadLinks(source, page(['https://example.org/file.pdf', '/file.pdf'])),
    ['https://research.worldlib.site/file.pdf']);
});

test('impossible calendar dates and future timestamps do not authorize downloading', async () => {
  const future = new Date(Date.now() + 86400000);
  const date = `${future.getFullYear()}/12/31 23:59:59`;
  for (const add_time of ['2026/02/31 12:00:00', '2026/01/01 25:00:00', date]) {
    const {client} = setup([row({add_time})]);
    assert.deepEqual((await client.results(session))[0].links, []);
  }
});

test('missing remote results never reuse cached links or resubmit old tasks', async () => {
  const job = newJob({state:'waiting',remoteIDs:['123'],submittedAt:Date.now()-72*3600000,
    links:['https://npc1.worldlib.site/cached.pdf']});
  const {engine,actions} = engineFor(job);
  await engine.process(job, session, {records:[],complete:true});
  assert.deepEqual(actions, []);
  assert.deepEqual(job.links, []);
});

test('task snapshots never persist account-bearing links, including hidden jobs', async () => {
  const secret = 'synthetic-private-account';
  const job = newJob({hidden:true, links:[`https://research.worldlib.site/file?uid=${secret}`]});
  const saved = [];
  const engine = new Core.Engine({store:{save:async data=>saved.push(data)}});
  engine.data.jobs = [job];
  await engine.save();
  assert.equal(JSON.stringify(saved).includes(secret), false);
  assert.deepEqual(saved[0].jobs[0].links, []);
  assert.equal(job.links.length, 1);
  assert.deepEqual(Core.persistentState({jobs:[job]}).jobs[0].links, []);
});

test('legacy links are discarded on load without losing reconciliation metadata', async () => {
  const job = newJob({state:'downloading',remoteIDs:['123'],submittedAt:1,
    links:['https://research.worldlib.site/file?uid=synthetic-account']});
  const engine = new Core.Engine({store:{load:async()=>({version:1,jobs:[job]})}});
  await engine.init();
  assert.deepEqual(engine.data.jobs[0].links, []);
  assert.deepEqual(engine.data.jobs[0].remoteIDs, ['123']);
  assert.equal(engine.data.jobs[0].state, 'waiting');
});
test('malformed and login responses stop processing, rather than allowing submission', async () => {
  for (const response of ['', ' ', '<html>登录</html>', '{"status":10}', '[{}]']) {
    const client = new Client({getIdentity:()=>identity,request:async()=>response});
    await assert.rejects(client.history(session), e => e.code === 'protocol');
  }
});
test('account switch is rejected before querying results', async () => {
  const client = new Client({getIdentity:()=>({unionid:'another-account'}),request:async()=>{throw Error('must not run');}});
  await assert.rejects(client.results(session), e => e.code === 'login');
});
test('DOI matching remains strict and ambiguous tasks are not auto-selected', () => {
  const r = {id:'123',messageID:'',dois:[row().title]};
  assert.equal(Core.matchRecord({doi:row().title,remoteIDs:[]}, [r]), r);
  assert.throws(()=>Core.matchRecord({doi:row().title,remoteIDs:[]}, [r,{...r,id:'124'}]), e=>e.code==='ambiguous');
});
test('broken legacy pagination is never used by the new default workflow', async () => {
  const { client } = setup([row()]);
  client.messageHistory = async () => { throw new Core.TaskError('protocol', 'cursor did not advance'); };
  const result = await client.history(session);
  assert.equal(result.complete, true);
  assert.equal(result.records[0].complete, true);
  assert.equal(result.records[0].links.length, 1);
});
test('matching pinned tasks do not need the legacy message endpoint', async () => {
  const { client, calls } = setup([row()]);
  const result = await client.history(session, [{doi:row().title,remoteIDs:['123']}]);
  assert.equal(calls.length, 1);
  assert.equal(result.records[0].complete, true);
});
test('only missing previously submitted jobs trigger historical reconciliation', async () => {
  const { client, calls } = setup([], [row()]);
  const result = await client.history(session, [{doi:row().title,remoteIDs:['123'],submittedAt:1}]);
  assert.equal(result.records.length,1);
  assert.deepEqual(calls.map(c=>new URLSearchParams(c.body).get('ishistory')),['0','1']);
});
test('old unrelated history does not block a fresh demand', async () => {
  const {client,calls}=setup([], [row({add_time:'2020/01/01 00:00:00'})]);
  const history=await client.history(session,[{doi:row().title,remoteIDs:[],submittedAt:0}]);
  assert.equal(calls.length,1);
  assert.deepEqual(history,{records:[],complete:true});
});
function engineFor(job) {
  const actions=[];
  const engine=new Core.Engine({store:{save:async()=>{}},site:{
    prepare:async()=>actions.push('prepare'),submit:async()=>{actions.push('submit');return [];}
  },library:{attach:async()=>{actions.push('attach');return {};}}});
  engine.data.jobs=[job];return {engine,actions};
}
const newJob=extra=>({id:'test',doi:row().title,state:'queued',remoteIDs:[],links:[],submittedAt:0,
  targets:[{libraryID:1,key:'TESTITEM',state:'pending'}],...extra});
test('no recent match and no local submission submits once through the old endpoint adapter',async()=>{
  const {client}=setup([]);
  const job=newJob();const {engine,actions}=engineFor(job);
  await engine.process(job,session,await client.history(session,[job]));
  assert.deepEqual(actions,['prepare','submit']);
  assert.equal(job.state,'waiting');
  await engine.process(job,session,{records:[],complete:true});
  assert.deepEqual(actions,['prepare','submit']);
});
test('pending recent demand is reused without another submission',async()=>{
  const {client}=setup([row({status:'待应助',url:''})]);
  const job=newJob();const {engine,actions}=engineFor(job);
  await engine.process(job,session,await client.history(session,[job]));
  assert.deepEqual(actions,[]);
  assert.equal(job.state,'waiting');
  assert.deepEqual(job.remoteIDs,['123']);
});
test('local remote task ID prevents submission even when timestamp is missing',async()=>{
  const job=newJob({remoteIDs:['123']});const {engine,actions}=engineFor(job);
  await assert.rejects(engine.process(job,session,{records:[],complete:true}),e=>e.code==='submit_unknown');
  assert.deepEqual(actions,[]);
});
test('incomplete recent query never allows a new submission',async()=>{
  const job=newJob();const {engine,actions}=engineFor(job);
  await assert.rejects(engine.process(job,session,{records:[],complete:false}),e=>e.code==='history_incomplete');
  assert.deepEqual(actions,[]);
});
test('historical query failure preserves recent matches and prevents fresh submission',async()=>{
  const {client}=setup([row()]);
  const request=client.request;
  client.request=async(method,url,body)=>{
    if(new URLSearchParams(body).get('ishistory')==='1')throw new Core.TaskError('network','offline');
    return request(method,url,body);
  };
  const result=await client.history(session,[{doi:'10.1016/missing',remoteIDs:['456'],submittedAt:1}]);
  assert.equal(result.complete,false);
  assert.equal(result.records[0].complete,true);
});
test('a previously waiting task completes without resubmission using the result page', async () => {
  const { client } = setup([row()]);
  const history = await client.history(session, [{doi:row().title,remoteIDs:['123']}]);
  let submitted = 0, attached = 0;
  const engine = new Core.Engine({store:{save:async()=>{}},site:{submit:async()=>{submitted++;}},
    library:{attach:async()=>{attached++;return {attachmentKey:'TESTPDF'};}}});
  const job={id:'test',doi:row().title,state:'waiting',remoteIDs:['123'],links:[],submittedAt:1,
    targets:[{libraryID:1,key:'TESTITEM',state:'pending'}]};
  engine.data.jobs=[job];
  await engine.process(job,session,history);
  assert.equal(submitted,0);
  assert.equal(attached,1);
  assert.equal(job.state,'done');
});

function emptyListClient(profile) {
  const calls = [];
  const client = new Client({ getIdentity: () => identity, request: async (method, url, body) => {
    calls.push({ method, url, body });
    if (url.includes('getpersondoc_new')) return '';
    if (url.includes('user_getwxid')) return typeof profile === 'string' ? profile : JSON.stringify(profile);
    return JSON.stringify({ status: 0, data: [] });
  }});
  return { client, calls };
}
const profileRow = extra => ({ status: 1, userid: '123456', usertype: 64, remainday: 47, ...extra });

test('an empty 文献管理 list is no data, not a protocol failure, when the account still resolves', async () => {
  const { client, calls } = emptyListClient(profileRow());
  const result = await client.history(session);
  assert.equal(result.complete, true);
  assert.deepEqual(result.records, []);
  assert.equal(calls.filter(c => c.url.includes('getpersondoc_new')).length, 1);
  assert.equal(calls.filter(c => c.url.includes('user_getwxid')).length, 1);
});

test('an empty list with an unresolvable account stays a protocol failure and never submits', async () => {
  for (const profile of [profileRow({ status: 0 }), profileRow({ userid: '' }), '<html>登录</html>', '']) {
    const { client } = emptyListClient(profile);
    await assert.rejects(client.history(session), e => e.code === 'protocol');
  }
});

test('an empty list still lets an already submitted job be reconciled from history', async () => {
  const calls = [];
  const client = new Client({ getIdentity: () => identity, request: async (method, url, body) => {
    calls.push(body);
    if (url.includes('getpersondoc_new')) {
      return new URLSearchParams(body).get('ishistory') === '0' ? '' : JSON.stringify([row()]);
    }
    return JSON.stringify(profileRow());
  }});
  const result = await client.history(session, [{ doi: row().title, remoteIDs: [], submittedAt: 1 }]);
  assert.equal(result.complete, true);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].complete, true);
});

test('permission checks fall back to the profile endpoint when usertype cookies are gone', async () => {
  const calls = [];
  const client = new Client({ getIdentity: () => identity, request: async (method, url) => {
    calls.push(url);
    if (url.includes('checkP')) return JSON.stringify({ status: 0 });
    return JSON.stringify(profileRow());
  }});
  await client.prepare(session);
  assert.equal(calls.filter(u => u.includes('user_getwxid')).length, 1);
});

test('permission checks still refuse an expired account resolved from the profile endpoint', async () => {
  const client = new Client({ getIdentity: () => identity, request: async (method, url) => {
    if (url.includes('checkP')) return JSON.stringify({ status: 0 });
    return JSON.stringify(profileRow({ remainday: 0 }));
  }});
  await assert.rejects(client.prepare(session), e => e.code === 'permission' && /到期/.test(e.message));
  const unopened = new Client({ getIdentity: () => identity, request: async (method, url) => {
    if (url.includes('checkP')) return JSON.stringify({ status: 0 });
    return JSON.stringify(profileRow({ usertype: 4 }));
  }});
  await assert.rejects(unopened.prepare(session), e => e.code === 'permission' && /未开通/.test(e.message));
});

test('landing page http links to a public address are accepted, private ones are not', async () => {
  const client = new Client({ request: async () => '<html></html>' });
  const anchor = href => ({ textContent: '文件下载', getAttribute: () => href });
  const page = links => () => ({ querySelectorAll: () => links.map(anchor) });
  const source = 'https://research.worldlib.site/tools/submit_ajax.ashx?action=getdownfile&path=/a.pdf';
  const public1 = 'http://203.0.113.10:8123/UPLOAD/202610/30/example.PDF?token=abc';
  assert.deepEqual(await client.downloadLinks(source, page([public1])), [public1]);
  for (const bad of ['http://127.0.0.1/a.pdf', 'http://10.0.0.5:8123/a.pdf', 'http://192.168.1.9/a.pdf',
    'http://169.254.1.1/a.pdf', 'http://172.20.0.1/a.pdf', 'http://100.64.0.1/a.pdf',
    'http://999.1.1.1/a.pdf', 'http://user:pw@203.0.113.10:8123/a.pdf', 'ftp://203.0.113.10/a.pdf']) {
    await assert.rejects(client.downloadLinks(source, page([bad])), e => e.code === 'invalid_pdf');
  }
});

test('a raw http address is still rejected before the landing page is resolved', async () => {
  assert.equal(Core.isLandingDownloadURL('http://203.0.113.10:8123/UPLOAD/a.PDF'), true);
  assert.equal(Core.isSafeDownloadURL('http://203.0.113.10:8123/UPLOAD/a.PDF'), false);
  const { client } = setup([row({ url: 'http://203.0.113.10:8123/UPLOAD/a.PDF' })]);
  assert.deepEqual((await client.results(session))[0].links, []);
});
