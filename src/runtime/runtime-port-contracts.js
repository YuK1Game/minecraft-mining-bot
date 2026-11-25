'use strict'

// Explicit capabilities retained by each extracted Runtime factory. Aliases keep
// the original rt.* calling convention; only actual assignments grant writes.
module.exports = {
  safety: {
    groups: {
      environment: 'delay host require'.split(' '),
      work: 'WORK_MARGIN activeUnarmedSpiderFloor autonomy boundedJumpSearch captureWorkActors clearanceDistanceAllowed clearanceTargetAllowed completedDryProofs constrainedSecondaryFloor createNavigator createWaterCounterattack depotBuilder depotStorage diagnoseStrikeBody excavation foraging generationHistory inspectEmergencyLeafPacket interactions isUnarmedCreeperZombie knownSurfaceBody lowHealthSurfaceEligible mining outsideSkeletonFloor outsideUnarmedSpiderFloor ownedMining planEmergencyLeafAsync planLearningShore planProtectiveDrownedStepAsync planProtectiveSkeletonStepAsync protectiveDrownedStepCurrent protectiveSkeletonStepCurrent recovery resolveWorkActors resourceMinHealth selectConstrainedPrimary shoreScore surfaceReturn terrainOcclusionApplies tunneling unarmedCreeperDrowned unarmedWaterDrowned unarmedWaterZombie unarmedZombieFloor unprovedInputFrames verifyCompletedDryProgress verifyQueuedTail verifyQueuedTailHandoff'.split(' '),
      lifecycle: 'actualLifeId currentGeneration own pendingStops requireGeneration'.split(' '),
      inventory: 'cancelBackgroundInventory clearanceEquipmentKey crafting drownedStepEquipmentKey food furnace inventory offhandTotem routeInventory'.split(' '),
      observation: 'chestStatus continuationScope craftStatus historyScope lightweightUserState planningWorld raw routeScope routeState sameRouteScope userScope working'.split(' '),
      protection: 'closeReturnedHut combatAttackExposure combatOwnsInput drownedStepThreatAllowed escapePaused evaluateThreats generationCombat generationHut generationSafety generationShelter idleSafety inspectIdleEscape inspectIdleEscapePacket inspectPartialEscapePacket logEscapePhase maintainIdle planRecentDamageRetreat retreatFrameAllowed safetyDispatchEpoch skeletonStepThreatAllowed userBehaviorOwns workEscapeEvaluation'.split(' '),
      motion: 'createGuardedRoute generationInput generationMovement generationPhysics generationPlanningPhysics generationStream guardRoute guardRouteProgress inputHistory inputOwner motionActive motionOrigin navigationDestination preMovementFences proveLearningShoreRoute proveLowHealthSurfaceRoute queuedMotionFrames routeMovement verifyRouteOrigin verifyRouteStanding'.split(' '),
    },
    writable: 'boundedJumpSearch guardRoute guardRouteProgress inspectEmergencyLeafPacket inspectIdleEscape inspectIdleEscapePacket inspectPartialEscapePacket motionOrigin'.split(' ').filter(Boolean)
  },
  userControl: {
    groups: {
      lifecycle: 'actualLifeId currentGeneration disposed disposing pendingStops replaying requireGeneration'.split(' '),
      observation: 'allActors chestStatus craftStatus lightweightRawState lightweightUserState raw rawScope userBehaviorGenerationScope userBehaviorSnapshot userScope working'.split(' '),
      inventory: 'armor chest craftInventory crafting food furnace inventory manualChestStorage requestInventoryResyncWithReceipt'.split(' '),
      work: 'KITE_ANGLES KITE_LANDING_POLLS KITE_RADII autonomy bowSightClearAt chunkMoveHeld createDefenseAnchor createNavigator createSightStanceSearch defenseEnabled depotBuilder depotPrebuild depotStorage excavation foraging fullStandingGeometry generationLadder generationPillar interactions knownSurfaceBody manualShulkerAbort manualShulkerRecovery mineLadderTask mining onUncertain prospecting quarryCanContinue quarryCanSelectTarget quarryCancellationRevision quarryEgressAbort quarryEgressTask quarryJob quarryPillarTask quarryPlacementPreparation recovery rememberCurrentMeleeReach resetHeld resourceMinHealth stopOrdinaryUserStream surfaceReturn surfaceReturnOwner tunneling'.split(' '),
      motion: 'cancelChunkMovement defenseMovementAllowed generationInput generationMovement generationPhysics generationStream motionActive motionOrigin movement portableMovementOwner portableMovementSerial walker yieldPortableMovement'.split(' '),
      protection: 'UserCombatItem combatAttackExposure combatExposure createUserBehaviors evaluateThreats generationCombat generationHut generationSafety generationShelter idleSafetyRuntime quarryCombatArmed quarryRetreatDepth startIdle threatReachability tickUserBehaviors userBehaviorError userBehaviorLease userBehaviorSleeping userBehaviorTimer userBehaviorWakePending userBehaviors'.split(' '),
      environment: 'delay host require'.split(' '),
    },
    writable: 'motionOrigin portableMovementOwner quarryCancellationRevision quarryRetreatDepth userBehaviorGenerationScope userBehaviorLease userBehaviorTimer userBehaviors'.split(' ').filter(Boolean)
  },
  operations: {
    groups: {
      work: 'activeBase autonomy bowSightClearAt cancelQuarryRestore chunkMoveHeld chunkTravel commitBrewMainDelta confirmQuarryPosition controlLocation createPlainsLocator createStoragePlacementAudit defenseEnabled depotMission depotPrebuild dragonInput emptyHandedPrep ensureChunkTravel ensureLoadoutReset ensureLongTravel ensureQuarryJob excavation executeSurfaceReturn findFlatArea foraging getRegisteredQuarryHomeSite inputStream interactions loadManualShulkerRecovery loadQuarryFile loadShoreHistory loadoutReset logicalWorkHeld longTravelLogAllowance manualGroundAccessProof manualShulkerAbort manualShulkerDocument manualShulkerRecovery manualShulkerTask measureSnapshots mineLadder mining missionJournal missionReady nearestHostileDistance normalizeChunkArea plainsLocator portableKeys portablePolicyError profileCpu prospecting quarryJob quarryPillar quarryPlacementPreparation quarryPorts quarryPositionVerifier quarryRuntime readCurrentTunnelFloors recovery requestQuarryTerrain resetHeld runManualShulkerRecovery runner selfEffectEvents selfResistance selfSlowFalling shoreMemory stopActions storagePlacementAudit surfaceReturn surfaceReturnOwner surveyShore testQuarryPillar travelPlaceTable travelRuntime travelSupplyBoxTake tunneling verifiedInitialLifeReceipt'.split(' '),
      lifecycle: 'actualLifeId disposed disposing ownedCall replaying'.split(' '),
      observation: 'allActors chestStatus guardRouteSnapshot idlePhysicsState lightweightRawState manualRecoveryState planningWorld quarrySnapshot quarryState raw rawScope safetySnapshot userBehaviorSnapshot userScope working'.split(' '),
      inventory: 'armor armorAutoAllowed armorTask armorWorkFree chest crafting ensureManualChestStorage equipManualArmor food foodKnownLife furnace inventory inventoryInspection inventoryLifeBaseKey inventoryStore manualChestStorage receivedEquipmentView requestInventoryResyncWithReceipt'.split(' '),
      motion: 'cancelChunkMovement clearMovementDestination clearNavigationDestination guardRoute guardRouteProgress inputHistory inputOwner motionOrigin movement movementDestination portableMovementOptions publishWalker startMotion walker yieldPortableMovement'.split(' '),
      protection: 'combat combatExposure hut idleSafety requireIdle resumeSafety safetyDispatchEpoch shelter stopIdleStream threatReachability tickUserBehaviors travelLeafEscape userBehaviorOwns userBehaviorTickTask userBehaviorWakePending userBehaviors'.split(' '),
      environment: 'host require'.split(' '),
    },
    writable: 'guardRouteProgress idlePhysicsState motionOrigin plainsLocator safetyDispatchEpoch storagePlacementAudit'.split(' ').filter(Boolean)
  },
  travel: {
    groups: {
      environment: '__dirname host require'.split(' '),
      lifecycle: 'actualLifeId disposed disposing'.split(' '),
      observation: 'allActors idlePhysicsState quarryState raw working'.split(' '),
      inventory: 'armor armorTask armorThreatNear armorWorkFree crafting inventory inventoryStore manualArmorOwner manualChestStorage'.split(' '),
      work: 'autonomy chunkMoveDepth chunkMoveJobIdentity chunkMoveLease chunkTravel controlLocation createChunkTravel createNavigator depotMission discardWorkingPrediction interactions loadoutReset longTravelLogAllowance manualShulkerTask nearestHostileDistance operations quarryJob quarryRestoreTask reconcilePlanningOrigin requestQuarryTerrain resetHeld verifyChunkMoveLease'.split(' '),
      motion: 'cancelChunkMovement ensureMovementLifeKnown idlePhysics motionOrigin movement portableMovementSerial startMotion stopChunkMovement'.split(' '),
      protection: 'combatAttackExposure idleSafety requireIdle resumeSafety stopIdleStream'.split(' '),
    },
    writable: 'chunkMoveDepth chunkMoveLease chunkTravel idlePhysicsState motionOrigin'.split(' ').filter(Boolean)
  },
}
