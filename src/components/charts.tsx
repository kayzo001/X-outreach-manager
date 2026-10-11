"use client";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const C = { primary: "hsl(252 88% 68%)", success: "hsl(152 62% 45%)", warn: "hsl(38 92% 56%)", grid: "hsl(224 16% 17%)", text: "hsl(218 12% 62%)" };
const tip = { contentStyle: { background: "hsl(224 22% 9%)", border: "1px solid hsl(224 16% 17%)", borderRadius: 8, fontSize: 12 }, cursor: { fill: "hsl(224 18% 14% / .6)" } };
const axis = { stroke: C.text, fontSize: 11, tickLine: false, axisLine: false } as const;

export function DailyChart({ data, series }: { data: { day: string; sent: number; replies: number }[]; series: "sent" | "replies" }) {
  const color = series === "sent" ? C.primary : C.success;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ left: -20, right: 8, top: 8 }}>
        <defs><linearGradient id={`g-${series}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.4} /><stop offset="100%" stopColor={color} stopOpacity={0} /></linearGradient></defs>
        <CartesianGrid stroke={C.grid} vertical={false} />
        <XAxis dataKey="day" {...axis} interval="preserveStartEnd" /><YAxis {...axis} allowDecimals={false} />
        <Tooltip {...tip} />
        <Area type="monotone" dataKey={series} stroke={color} strokeWidth={2} fill={`url(#g-${series})`} name={series === "sent" ? "Messages sent" : "Replies"} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
export function CampaignBars({ data }: { data: { name: string; sent: number; replied: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ left: -20, right: 8, top: 8 }}>
        <CartesianGrid stroke={C.grid} vertical={false} /><XAxis dataKey="name" {...axis} /><YAxis {...axis} allowDecimals={false} />
        <Tooltip {...tip} /><Legend wrapperStyle={{ fontSize: 11 }} />
        <Bar dataKey="sent" name="Sent" fill={C.primary} radius={[4, 4, 0, 0]} /><Bar dataKey="replied" name="Replied" fill={C.success} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
export function IndustryBars({ data }: { data: { industry: string; leads: number; contacted: number; replied: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(220, data.length * 34)}>
      <BarChart data={data} layout="vertical" margin={{ left: 20, right: 12, top: 8 }}>
        <CartesianGrid stroke={C.grid} horizontal={false} /><XAxis type="number" {...axis} allowDecimals={false} /><YAxis type="category" dataKey="industry" {...axis} width={110} />
        <Tooltip {...tip} /><Legend wrapperStyle={{ fontSize: 11 }} />
        <Bar dataKey="leads" name="Leads" fill="hsl(224 14% 32%)" radius={[0, 4, 4, 0]} /><Bar dataKey="contacted" name="Contacted" fill={C.primary} radius={[0, 4, 4, 0]} /><Bar dataKey="replied" name="Replied" fill={C.success} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
export function Funnel({ data }: { data: { stage: string; n: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.n));
  return (
    <div className="space-y-2.5">
      {data.map((d, i) => (
        <div key={d.stage}>
          <div className="mb-1 flex justify-between text-xs"><span className="text-muted-foreground">{d.stage}</span><span className="font-medium tabular-nums">{d.n.toLocaleString()}{i > 0 && data[0].n > 0 && <span className="ml-2 text-muted-foreground">{((d.n / data[0].n) * 100).toFixed(0)}% of imported</span>}</span></div>
          <div className="h-2.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full" style={{ width: `${Math.max(2, (d.n / max) * 100)}%`, background: `hsl(${252 - i * 16} 80% ${68 - i * 2}%)` }} /></div>
        </div>
      ))}
    </div>
  );
}
