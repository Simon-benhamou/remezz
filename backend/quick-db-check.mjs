import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const keys = await prisma.userApiKey.findMany({
  include: { user: { select: { email: true } } }
});

console.log('\n📋 API Keys:');
keys.forEach(k => {
  console.log(`${k.isActive ? '✅' : '⭕'} ${k.exchange.toUpperCase()} - ${k.user.email} (ID: ${k.id.substring(0,8)}...)`);
});

if (keys.length === 0) {
  console.log('❌ NO API KEYS FOUND!');
}

await prisma.$disconnect();
