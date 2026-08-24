// Seeds the first operator account. Credentials come from the environment -
// never from source (ops-team user management is out-of-band in v1).
//
//   OPERATOR_EMAIL=you@restiq.example OPERATOR_PASSWORD='...' pnpm run seed:operator
import 'dotenv/config'
import * as argon2 from 'argon2'
import { createPrismaClient } from '../src/db/client'

async function main(): Promise<void> {
  const email = process.env.OPERATOR_EMAIL?.trim().toLowerCase()
  const password = process.env.OPERATOR_PASSWORD
  if (!email || !password) {
    throw new Error('OPERATOR_EMAIL and OPERATOR_PASSWORD must be set')
  }

  const prisma = createPrismaClient()
  try {
    const passwordHash = await argon2.hash(password)
    const operator = await prisma.operatorUser.upsert({
      where: { email },
      update: { passwordHash },
      create: { email, passwordHash },
    })
    console.log(`operator ready: ${operator.email} (${operator.id})`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
