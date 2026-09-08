const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient({ datasourceUrl: 'postgresql://postgres:dDBVHXESUDZSzbCVPYFUeqexKnvRoIes@switchback.proxy.rlwy.net:49308/railway?sslmode=require' });

async function main() {
  // Last 5 bulk jobs
  const jobs = await p.bulkJob.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: {
      id: true, configId: true, shopDomain: true, phase: true,
      totalCount: true, createCount: true, updateCount: true, unchangedCount: true,
      excludedCount: true, errorCount: true, manifestPath: true,
      createdAt: true,
    },
  });
  console.log('=== BULK JOBS ===');
  jobs.forEach(j => console.log(JSON.stringify(j)));

  // Last 5 import logs
  const logs = await p.importLog.findMany({
    orderBy: { startedAt: 'desc' },
    take: 5,
    select: {
      id: true, configId: true, shopDomain: true, status: true,
      totalProducts: true, created: true, updated: true, unchanged: true,
      excludedCount: true, priceChanges: true, stockChanges: true,
      startedAt: true, completedAt: true,
    },
  });
  console.log('\n=== IMPORT LOGS ===');
  logs.forEach(l => console.log(JSON.stringify(l)));

  // Check product mappings count
  const mappingCount = await p.productMapping.count();
  console.log('\n=== PRODUCT MAPPINGS ===');
  console.log('Total mappings:', mappingCount);

  // Check a sample of mappings
  const sampleMappings = await p.productMapping.findMany({
    take: 5,
    orderBy: { createdAt: 'desc' },
    select: { shopDomain: true, supplierSku: true, shopifyProductId: true, ean: true, postProcessStatus: true },
  });
  console.log('Sample:', JSON.stringify(sampleMappings));

  await p.$disconnect();
}
main();
