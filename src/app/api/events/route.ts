import { requirePropertySession, propertyAccessResponse } from "@/server/auth/property-session";
import { changesAfter } from "@/server/realtime/change-events";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    const startCursor = Number(new URL(request.url).searchParams.get("cursor") ?? "0");
    const encoder = new TextEncoder();
    let cursor = Number.isSafeInteger(startCursor) && startCursor >= 0 ? startCursor : 0;
    let closed = false;
    request.signal.addEventListener("abort", () => { closed = true; });

    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown, id?: number) => {
          controller.enqueue(encoder.encode(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        send("ready", { propertyId: session.propertyId, cursor });
        while (!closed) {
          const events = await changesAfter(session.propertyId, cursor);
          for (const event of events) {
            cursor = event.id;
            send("change", {
              ...event,
              payload: JSON.parse(event.payloadJson),
              ownChange: event.actorAuthUserId === session.authUserId,
            }, event.id);
          }
          send("heartbeat", { cursor });
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        controller.close();
      },
      cancel() { closed = true; },
    });
    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
