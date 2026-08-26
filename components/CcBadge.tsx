'use client'

import StageBadge from '@/components/StageBadge'
import { CC_STAGE, CC_VERSION } from '@/lib/ccVersion'

export default function CcBadge() { return <StageBadge stage={CC_STAGE} version={CC_VERSION} /> }
