const { PrismaClient } = require('./node_modules/@prisma/client');
const p = new PrismaClient();
p.importConfig.findMany({ where: { isActive: true }, select: { id: true, name: true, frequency: true, importMode: true, lastImportAt: true } }).then(function(r) { console.log(JSON.stringify(r, null, 2)); }).finally(function() { p.$disconnect(); });
