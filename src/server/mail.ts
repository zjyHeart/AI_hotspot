import nodemailer from 'nodemailer';
import { and, eq, lte, lt, inArray } from 'drizzle-orm';
import { getDb } from './db';
import { notifications, deliveryAttempts, events, articles } from './schema';
import { emailConfigured } from './config';
import { safeError, ServiceError } from './http';
import { credibilityNames } from '../shared/types';
import { randomUUID } from 'node:crypto';

function transport(){return nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT)||465,secure:process.env.SMTP_SECURE?process.env.SMTP_SECURE==='true':Number(process.env.SMTP_PORT||465)===465,requireTLS:Number(process.env.SMTP_PORT||465)!==465,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD},tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:30000});}
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function acceptedTarget(accepted:unknown[],target:string){return accepted.some(a=>String(typeof a==='object'&&a!==null&&'address' in a?a.address:a).toLowerCase()===target.trim().toLowerCase());}
export async function testMail(){
  if(!emailConfigured())throw new ServiceError('邮件未配置，请填写 SMTP 与发件/收件地址',400);
  const t=transport();await t.verify();const info=await t.sendMail({from:process.env.EMAIL_FROM,to:process.env.EMAIL_TO,subject:'[Signal Desk] 邮件连接测试',text:'这是一封由你主动触发的测试邮件。SMTP 服务器接受邮件不保证最终进入收件箱。'});
  if(!acceptedTarget(info.accepted||[],process.env.EMAIL_TO!))throw new ServiceError('SMTP 没有接受目标收件人');
  return {message:'SMTP 已接受测试邮件，请检查收件箱',messageId:info.messageId};
}
export async function deliverNotifications(){
  if(!emailConfigured())return;
  const db=getDb();const now=Date.now();const list=db.select().from(notifications).where(and(inArray(notifications.emailStatus,['queued','retry','unconfigured']),lte(notifications.nextAttemptAt,now),lt(notifications.attempts,3),lte(notifications.leaseUntil,now))).limit(8).all();
  for(const n of list){const claimed=db.update(notifications).set({leaseUntil:now+120000,emailStatus:'sending'}).where(and(eq(notifications.id,n.id),lte(notifications.leaseUntil,now),inArray(notifications.emailStatus,['queued','retry','unconfigured']))).run();if(!claimed.changes)continue;
    try{
      const event=db.select().from(events).where(eq(events.id,n.eventId)).get();const evidence=event?.evidence||[];const sources=evidence.map(e=>db.select().from(articles).where(eq(articles.id,e.articleId)).get()).filter(x=>x!==undefined);
      const label=event?credibilityNames[event.credibility]:'新信号';const text=`${n.title}\n\n${n.body}\n\n证据状态：${label}\n${sources.map(a=>a.url).join('\n')}`;
      const info=await transport().sendMail({from:process.env.EMAIL_FROM,to:process.env.EMAIL_TO,messageId:`<${n.id}@signal-desk.local>`,subject:`[热点信号] ${n.title}`,text,html:`<h2>${escape(n.title)}</h2><p>${escape(n.body)}</p><p>证据状态：${escape(label)}</p>${sources.map(a=>`<p><a href="${escape(a.url)}">${escape(a.title)}</a></p>`).join('')}`});
      if(!acceptedTarget(info.accepted||[],process.env.EMAIL_TO!))throw new ServiceError('SMTP 没有接受目标收件人');
      db.update(notifications).set({emailStatus:'accepted',attempts:n.attempts+1,leaseUntil:0,lastError:null}).where(eq(notifications.id,n.id)).run();
      db.insert(deliveryAttempts).values({id:randomUUID(),notificationId:n.id,createdAt:Date.now(),status:'accepted',error:null}).run();
    }catch(error){const message=safeError(error);const code=typeof error==='object'&&error!==null&&'code' in error?String(error.code):'';const responseCode=typeof error==='object'&&error!==null&&'responseCode' in error?Number(error.responseCode):0;const permanent=code==='EAUTH'||(responseCode>=500&&responseCode<600);const attempts=n.attempts+1;
      db.update(notifications).set({emailStatus:permanent||attempts>=3?'failed':'retry',attempts,leaseUntil:0,nextAttemptAt:Date.now()+60000*2**attempts,lastError:message}).where(eq(notifications.id,n.id)).run();
      db.insert(deliveryAttempts).values({id:randomUUID(),notificationId:n.id,createdAt:Date.now(),status:'failed',error:message}).run();
    }
  }
  // Recover outbox jobs after a worker crash. The stable Message-ID aids provider deduplication, but SMTP cannot guarantee exactly once.
  db.update(notifications).set({emailStatus:'retry',leaseUntil:0}).where(and(eq(notifications.emailStatus,'sending'),lte(notifications.leaseUntil,now))).run();
}
