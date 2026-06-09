// providers/openai.js
export const OpenAIAdapter = {
    name: 'openai',
    
    // The target destination
    hostname: 'api.openai.com',
    port: 443,

    // Header Surgery: What do we change before sending upstream?
    transformHeaders: (incomingHeaders) => {
        const outgoing = { ...incomingHeaders };
        // Force the host to match the destination so their load balancer accepts it
        outgoing.host = 'api.openai.com'; 
        return outgoing;
    },

    // Path Surgery: How do we map the local URL to the provider's API?
    // OpenAI is the standard, so we usually just pass it straight through.
    transformPath: (incomingUrl) => {
        return incomingUrl; 
    }
};

