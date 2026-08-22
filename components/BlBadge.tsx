'use client'

import StageBadge from '@/components/StageBadge'
import { BL_STAGE, BL_VERSION } from '@/lib/blVersion'

export default function BlBadge() { return <StageBadge stage={BL_STAGE} version={BL_VERSION} /> }
