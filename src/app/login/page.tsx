import { Zap } from "lucide-react";
import { Button, Card, Input, Label } from "@/components/ui";

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <Card className="w-full max-w-sm p-7">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary text-primary-foreground glow"><Zap className="h-5 w-5" /></div>
          <div><h1 className="text-lg font-semibold">X Outreach Manager</h1><p className="text-xs text-muted-foreground">Sign in to continue</p></div>
        </div>
        <form action="/api/auth/login" method="post" className="space-y-4">
          <div><Label>Email</Label><Input name="email" type="email" required autoComplete="username" autoFocus /></div>
          <div><Label>Password</Label><Input name="password" type="password" required autoComplete="current-password" /></div>
          {error && <p className="text-xs text-destructive">Invalid credentials.</p>}
          <Button variant="primary" className="w-full">Sign in</Button>
        </form>
      </Card>
    </main>
  );
}
