import { prisma } from "./app/lib/db.server.js";

const configs = await prisma.importConfig.findMany({
  where: { isActive: true },
  select: { id: true, name: true, frequency: true },
});
console.log(JSON.stringify(configs, null, 2));
await prisma.$disconnect();
