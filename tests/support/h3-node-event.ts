import type { IncomingMessage, ServerResponse } from 'node:http'
import { H3Event } from 'h3'
import { NodeRequest } from 'srvx/node'

export function createNodeEvent(req: IncomingMessage, res: ServerResponse) {
  return new H3Event(new NodeRequest({ req, res }))
}
