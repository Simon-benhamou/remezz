/**
 * Backfill missing fees in Fill table
 * For all fills where fee is null, calculate fee as: qty × price × 0.0004 (0.04% taker)
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function backfillFees() {
  console.log('🔄 Backfilling missing fees in Fill table...\n');

  // Get all fills with null fee
  const fillsWithNullFee = await prisma.fill.findMany({
    where: { fee: null },
    orderBy: { ts: 'desc' },
  });

  console.log(`Found ${fillsWithNullFee.length} fills with null fee\n`);

  if (fillsWithNullFee.length === 0) {
    console.log('✅ No fills need updating');
    return;
  }

  // Show preview
  console.log('Preview of fills to update:');
  console.log('─'.repeat(80));
  
  let totalNotional = 0;
  let totalFees = 0;

  for (const fill of fillsWithNullFee.slice(0, 10)) {
    const notional = fill.qty * fill.price;
    const fee = notional * 0.0004;
    totalNotional += notional;
    totalFees += fee;
    
    console.log(`  ${fill.ts.toISOString().slice(0,19)} | ${fill.symbol.padEnd(12)} | ${fill.side.padEnd(4)} | notional=$${notional.toFixed(2).padStart(8)} | fee=$${fee.toFixed(4)}`);
  }
  
  if (fillsWithNullFee.length > 10) {
    console.log(`  ... and ${fillsWithNullFee.length - 10} more`);
  }

  // Calculate totals for all
  for (const fill of fillsWithNullFee.slice(10)) {
    const notional = fill.qty * fill.price;
    const fee = notional * 0.0004;
    totalNotional += notional;
    totalFees += fee;
  }

  console.log('─'.repeat(80));
  console.log(`Total notional: $${totalNotional.toFixed(2)}`);
  console.log(`Total fees to backfill: $${totalFees.toFixed(2)}`);
  console.log('');

  // Perform update
  console.log('Updating fills...');
  
  let updated = 0;
  for (const fill of fillsWithNullFee) {
    const notional = fill.qty * fill.price;
    const fee = notional * 0.0004;
    
    await prisma.fill.update({
      where: { id: fill.id },
      data: { fee },
    });
    
    updated++;
    if (updated % 50 === 0) {
      console.log(`  Updated ${updated}/${fillsWithNullFee.length}...`);
    }
  }

  console.log(`\n✅ Successfully updated ${updated} fills with calculated fees`);
  
  // Verify
  const remainingNull = await prisma.fill.count({ where: { fee: null } });
  console.log(`Remaining fills with null fee: ${remainingNull}`);
}

backfillFees()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
