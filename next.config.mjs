export default {
  async rewrites() {
    return [
      { source: '/api/web-chat', destination: 'http://127.0.0.1:4402/api/web-chat' },
      { source: '/api/slack/:agent(ada|sam)', destination: 'http://127.0.0.1:4402/api/slack/:agent' },
      { source: '/integrations/slack/:agent(ada|sam)/oauth/callback', destination: 'http://127.0.0.1:4402/integrations/slack/:agent/oauth/callback' },
      { source: '/integrations/slack/:agent(ada|sam)/events', destination: 'http://127.0.0.1:4402/integrations/slack/:agent/events' },
      { source: '/api/slack', destination: 'http://127.0.0.1:4402/api/slack' },
      { source: '/integrations/slack/oauth/callback', destination: 'http://127.0.0.1:4402/integrations/slack/oauth/callback' },
      { source: '/integrations/slack/events', destination: 'http://127.0.0.1:4402/integrations/slack/events' },
      { source: '/api/:path*', destination: 'http://127.0.0.1:4000/api/:path*' },
    ];
  },
};
