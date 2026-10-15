import { sync } from "@/lib/sync";

export const maxDuration = 120;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    return Response.json({ ok: true, ...(await sync()) });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message.slice(0, 300) }, { status: 500 });
  }
}
