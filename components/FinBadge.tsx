'use client'

import StageBadge from '@/components/StageBadge'
import { FIN_STAGE, FIN_VERSION } from '@/lib/finVersion'

export default function FinBadge() { return <StageBadge stage={FIN_STAGE} version={FIN_VERSION} /> }
