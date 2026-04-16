import { getStats } from "@/lib/floatty-client";

export async function GET() {
  try {
    const stats = await getStats();
    return Response.json(stats);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
