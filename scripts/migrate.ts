import nextEnv from '@next/env';
const { loadEnvConfig }=nextEnv;
loadEnvConfig(process.cwd());
const { getStore } = await import('../src/server/db');
const store = getStore();
console.log('Database migrations applied.');
store.sqlite.close();
