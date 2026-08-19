// DealPilot DSH — Client entry point
// Registers the DealPilot Dashboard UI into the DSH Web GUI slot system.
// Implementation coming in S8.
export function apply(ctx) {
    const slots = ctx.get?.('slots');
    if (!slots) {
        console.warn('[dealpilot:client] slots not available — UI not registered');
        return;
    }
    console.log('[dealpilot:client] slots available — Dashboard UI will be registered in S8');
}
