import { prisma } from '../src/db/client.js';

async function testRelations() {
  console.log('Testing Prisma relations...\n');

  try {
    // Test 1: AgentSession with SessionKpi
    console.log('1. Testing AgentSession.SessionKpi relation:');
    const session = await prisma.agentSession.findFirst({
      include: { SessionKpi: true }
    });
    console.log('✅ SessionKpi include works');
    console.log('   Has SessionKpi data:', session?.SessionKpi ? 'yes' : 'no');

    // Test 2: AgentSession with positions
    console.log('\n2. Testing AgentSession.positions relation:');
    const sessionWithPositions = await prisma.agentSession.findFirst({
      include: { positions: true }
    });
    console.log('✅ positions include works');
    console.log('   Has positions:', sessionWithPositions?.positions?.length || 0);

    // Test 3: Order with fills
    console.log('\n3. Testing Order.fills relation:');
    const order = await prisma.order.findFirst({
      include: { fills: true }
    });
    console.log('✅ fills include works');
    console.log('   Has fills:', order?.fills?.length || 0);

    // Test 4: Combined test
    console.log('\n4. Testing combined relations:');
    const fullSession = await prisma.agentSession.findFirst({
      include: {
        SessionKpi: true,
        positions: true,
        orders: {
          include: { fills: true }
        }
      }
    });
    console.log('✅ All relations work together');

    console.log('\n✅ All Prisma relation tests passed!');
  } catch (error: any) {
    console.error('❌ Test failed:', error.message);
    if (error.message.includes('Unknown field')) {
      console.error('\nThe error suggests the field name in the include is wrong.');
      console.error('Check the schema.prisma file for the correct relation field names.');
    }
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

testRelations();
