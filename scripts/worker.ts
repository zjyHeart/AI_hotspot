import nextEnv from '@next/env';
const { loadEnvConfig }=nextEnv;
loadEnvConfig(process.cwd(),process.env.NODE_ENV!=='production');
const { writeSetting }=await import('../src/server/config');
const { nextDueMonitor,scanMonitor }=await import('../src/server/scanner');
const { processNextAnalysis, enqueuePipeline }=await import('../src/server/pipeline');
const { getDb }=await import('../src/server/db');
const { monitors }=await import('../src/server/schema');
const { deliverNotifications }=await import('../src/server/mail');
const { safeError }=await import('../src/server/http');
let stopping=false;
process.on('SIGINT',()=>{stopping=true;});process.on('SIGTERM',()=>{stopping=true;});
writeSetting('workerAt',Date.now());const heartbeat=setInterval(()=>writeSetting('workerAt',Date.now()),10000);
for(const monitor of getDb().select().from(monitors).all()) enqueuePipeline(monitor);
console.log('Signal Desk worker started. Polling due monitors every 5 seconds.');
while(!stopping){try{const monitor=nextDueMonitor();if(monitor){console.log(`Scanning monitor ${monitor.id}`);await scanMonitor(monitor.id);}await processNextAnalysis();await deliverNotifications();}catch(error){console.error(safeError(error));}if(!stopping)await new Promise(resolve=>setTimeout(resolve,5000));}
clearInterval(heartbeat);writeSetting('workerAt',0);console.log('Worker stopped after finishing the current task.');
