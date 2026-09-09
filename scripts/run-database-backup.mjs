import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { spawn } from 'node:child_process';
const bad=(m)=>{throw Error(m)};
const safe=(x)=>typeof x==='string'&&isAbsolute(x)&&x===resolve(x)&&!x.includes('\0');
async function status(path,value){const t=`${path}.tmp`;await writeFile(t,JSON.stringify(value)+'\n',{mode:0o600});await rename(t,path)}
export async function runBackup({stateDirectory,exportSnapshot,backupSnapshot,run=command}) {
 if(!safe(stateDirectory))bad('state directory'); await mkdir(stateDirectory,{recursive:true,mode:0o700});
 const lock=`${stateDirectory}/lock`; try{await mkdir(lock,{mode:0o700})}catch{bad('backup already running')}
 const statePath=`${stateDirectory}/status.json`; let previous={};try{previous=JSON.parse(await readFile(statePath,'utf8'))}catch{}
 const startedAt=Date.now(); await status(statePath,{state:'running',startedAt,lastSuccess:previous.lastSuccess??null});
 try { const snapshot=await exportSnapshot(); if(!snapshot||!safe(snapshot.directory))bad('invalid export result'); await backupSnapshot(snapshot.directory); const finishedAt=Date.now(); await status(statePath,{state:'succeeded',startedAt,finishedAt,lastSuccess:finishedAt}); return snapshot; }
 catch(error){await status(statePath,{state:'failed',startedAt,finishedAt:Date.now(),lastSuccess:previous.lastSuccess??null,failure:{stage:'command',code:'failed'}});throw error}
 finally{await rm(lock,{recursive:true,force:true})}
}
export async function command({argv,cwd,timeoutMs=60000,env={}}){if(!Array.isArray(argv)||!argv.length||!safe(argv[0])||!safe(cwd))bad('command');return await new Promise((ok,no)=>{const p=spawn(argv[0],argv.slice(1),{cwd,env:{PATH:env.PATH,HOME:process.env.HOME,...env},detached:true,stdio:['ignore','pipe','pipe']});let out='';let err='';const cap=s=>d=>{s+=d;return s};p.stdout.on('data',d=>{out=cap(out)(d);if(out.length>65536)p.kill(-p.pid)});p.stderr.on('data',d=>{err=cap(err)(d);if(err.length>65536)p.kill(-p.pid)});const timer=setTimeout(()=>p.kill(-p.pid),timeoutMs);p.on('close',c=>{clearTimeout(timer);c===0?ok(out):no(Error('child failed'))})})}
