export default {
  async rewrites() {
    return [
      { source: '/api/web-chat', destination: 'http://127.0.0.1:4402/api/web-chat' },
      { source: '/api/:path*', destination: 'http://127.0.0.1:4000/api/:path*' },
    ];
  },
};
