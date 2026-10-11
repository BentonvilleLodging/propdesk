// Disabled: this edge function previously injected js/intel-ws.js into every page and
// coincided with a login outage. It now only matches an unused path and passes through.
export default async (request, context) => context.next();

export const config = { path: '/__inject-ext-disabled' };
