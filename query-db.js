const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.importConfig.findMany({select:{id:true,filterType:true,filterSkus:true,filterCategories:true,publicationIds:true,marketIds:true}}).then(r => {
  console.log(JSON.stringify(r,null,2));
  p.$disconnect();
}).catch(e => { console.error(e); p.$disconnect(); });
