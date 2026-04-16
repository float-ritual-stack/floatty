import { listBlocks } from "@/lib/floatty-client";

export async function GET() {
  try {
    const data = await listBlocks();
    return Response.json(data);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
