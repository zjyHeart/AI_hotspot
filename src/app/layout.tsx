import type { Metadata } from 'next';
import './globals.css';
export const metadata:Metadata={title:'Signal Desk · 热点信号台',description:'在噪声里，捕捉下一条信号。关键词监控、AI 热点发现与有据可查的情报。'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body>{children}</body></html>;}
