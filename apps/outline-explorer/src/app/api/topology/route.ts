import { getTopology } from "@/lib/floatty-client";

export async function GET() {
  try {
    const topology = await getTopology();
    return Response.json(topology);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
