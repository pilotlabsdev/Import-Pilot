const { PrismaClient } = require('./node_modules/@prisma/client');
const p = new PrismaClient();
async function main() {
  const queue = await p.importQueue.findMany({
    where: { shopDomain: "status-pilot-test.myshopify.com" },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, configId: true, status: true, triggerType: true, importMode: true, createdAt: true }
  });
  console.log("=== IMPORT QUEUE ===");
  for (const q of queue) {
    const cfg = await p.importConfig.findUnique({ where: { id: q.configId }, select: { name: true } });
    console.log(`[${cfg?.name}] status=${q.status} trigger=${q.triggerType} mode=${q.importMode} created=${q.createdAt?.toISOString()}`);
  }
  if (queue.length === 0) console.log("(vacío)");
  await p.$disconnect();
}
main();
