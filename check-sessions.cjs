const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient({ datasourceUrl: 'postgresql://postgres:dDBVHXESUDZSzbCVPYFUeqexKnvRoIes@switchback.proxy.rlwy.net:49308/railway?sslmode=require' });
p.session.findMany({
  select: { id: true, shop: true, isOnline: true, expires: true, accessToken: true, refreshToken: true, refreshTokenExpires: true },
  orderBy: { expires: 'desc' },
  take: 5
}).then(r => {
  r.forEach(s => console.log(JSON.stringify({
    ...s,
    accessToken: s.accessToken ? s.accessToken.substring(0, 8) + '...' : 'MISSING',
    refreshToken: s.refreshToken ? s.refreshToken.substring(0, 8) + '...' : 'MISSING'
  })));
  p.$disconnect();
});
