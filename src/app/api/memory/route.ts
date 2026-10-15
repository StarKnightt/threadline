import { forget, memorySnapshot } from "@/lib/memory";

const idRe = /^[a-zA-Z0-9-]{8,64}$/;

export async function GET(req: Request) {
  const userId = new URL(req.url).searchParams.get("userId") ?? "";
  if (!idRe.test(userId)) return Response.json({ error: "bad user id" }, { status: 400 });
  return Response.json(await memorySnapshot(userId));
}

export async function DELETE(req: Request) {
  const userId = new URL(req.url).searchParams.get("userId") ?? "";
  if (!idRe.test(userId)) return Response.json({ error: "bad user id" }, { status: 400 });
  await forget(userId);
  return Response.json({ ok: true });
}
