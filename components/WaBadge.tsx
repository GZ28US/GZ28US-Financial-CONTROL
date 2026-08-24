'use client'

import StageBadge from '@/components/StageBadge'
import { WA_STAGE, WA_VERSION } from '@/lib/waVersion'

export default function WaBadge() { return <StageBadge stage={WA_STAGE} version={WA_VERSION} /> }
