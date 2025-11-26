import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const user = await prisma.user.findUnique({ where: { username: 'simon' } });

if (!user) {
  console.log('❌ User not found in database');
  process.exit(1);
}

console.log('✅ User found:', user.id);
console.log('isLegacy:', user.isLegacy);
console.log('email:', user.email);

const match = await bcrypt.compare('shira1704', user.passwordHash);
console.log('Password matches:', match);

if (match) {
  console.log('\n✅ You can login with username=simon password=shira1704');
} else {
  console.log('\n❌ Password does not match');
}

await prisma.$disconnect();
