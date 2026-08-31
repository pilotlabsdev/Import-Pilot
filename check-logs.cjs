const { PrismaClient } = require('./node_modules/@prisma/client');
const p = new PrismaClient();
async function main() {
  const logs = await p.importLog.findMany({
    where: { shopDomain: "status-pilot-test.myshopify.com" },
    orderBy: { startedAt: "desc" },
    take: 15,
    select: { id: true, configId: true, status: true, triggerType: true, startedAt: true, completedAt: true, totalProducts: true, created: true, updated: true, unchanged: true }
  });
  console.log("=== IMPORT LOGS ===");
  for (const l of logs) {
    const cfg = await p.importConfig.findUnique({ where: { id: l.configId }, select: { name: true, importMode: true } });
    console.log(`[${cfg?.name} ${cfg?.importMode}] status=${l.status} trigger=${l.triggerType} started=${l.startedAt?.toISOString()} products=${l.totalProducts} created=${l.created} updated=${l.updated} unchanged=${l.unchanged}`);
  }
  await p.$disconnect();
}
main();
