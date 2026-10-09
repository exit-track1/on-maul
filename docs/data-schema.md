# 온 마을 합성 데이터 스키마

schemaVersion `1.0.0`, seed `20261009`, referenceDate `2026-10-09`, timeZone `Asia/Seoul`. 모든 인물·주소·연락·차량·관측·확인 이력은 새로 작성한 허구다. 외부 전화·API·녹음·실수신·실동의 취득 기록이 아니다. 생성기를 저장하지 않고 정적인 JSON으로 제공한다.

| 파일 | 형태·수 | 핵심 필드·참조 |
| --- | --- | --- |
| metadata.json | 객체 1 | synthetic, schemaVersion, seed, referenceDate, timeZone, description, recordCounts, countingRules |
| zones.json | 배열 4 | id(W/N/E/S), label, teamId→teams, shelterId→shelters, householdCount, predictedArrivalMinutes, demoBounds |
| shelters.json | 배열 3 | id, name, type, capacity, demoLocation{x,y}, accessibility(confirmed/unconfirmed), petsAllowed, synthetic |
| households.json | 배열 48 | id, name, age, gender, priorityGrade(1~4), mobility(자력/보조/와상/불명), healthNotes[], zoneId, addressLabel, phoneKind, contactRef, guardian, consentToCall, callEligible, exclusionReason, sourceType, lastCheckedAt, originalNote, demoPosition, teamId, shelterId, cohabitant, devices[], synthetic |
| teams.json | 배열 4·조원 12 | id, zoneId, name, vehicleId, members[{id,name,roleLabel,canDrive,availability,reason,synthetic}], assignedHouseholdIds[], meetingPoint, synthetic |
| vehicles.json | 배열 10 | id, name, kind, organizationLabel, plateLabel, capacity, equipment[], driverRef→members, teamId, availableForTransport, unavailableReason, synthetic |
| sources.json | 배열 8 | id, category, name, demoRefreshSeconds, demoPayload{schema,summary,observedAt,windDirection,windSpeedMps,value}, synthetic |
| responseCases.json | 배열 14 | id, label, fictionalUtterance, demoOutcome, needsHumanReview, synthetic |
| scenarios.json | 배열 5 | id, label, displayTime, mode, householdStatuses[], counts, pendingReviewIds[], resourceStatuses[], sourceStatuses[], synthetic |
| callTranscripts.json | 배열 10 | id, householdId, scenarioId, turns[{sequence,speaker,text,offsetSeconds}], synthetic |
| eventLogs.json | 배열 5 | id, scenarioId, timestamp, actorType, label, householdId?, teamId?, vehicleId?, synthetic |
| checkLogs.json | 배열 96 | id, householdId, sourceType, checkedAt, checkedFields[], changed(object/null), operatorLabel, evidence, synthetic |
| map.json | 객체 1 | width=1200, height=760, metersPerPixel=2, ignition, office, wind, roads[6], river, synthetic |
| bundle.json | 결합 객체 | 위 파일들의 동일 스냅샷. 타입은 shared/src/types.ts, 읽기 진입점은 shared/src/data.ts |

`null`은 해당 값이 없음을 나타낸다. 거동 `불명`은 확인이 필요하다는 뜻이다. `callEligible=false`는 방문 전용이며 안전 완료가 아니다. `temporaryExclusion`은 앱 런타임에서만 추가하는 임시 제외 사유다. 원본 JSON의 정적 시나리오에는 임시 제외가 없다.

연락처는 null 또는 `DEMO-CONTACT-…`, 주소는 `DEMO-…`, 번호판은 `DEMO-VEHICLE-…`이다. 실제 발신 가능한 번호가 없으며 실제 수신자는 데이터와 분리된 환경변수로만 설정한다.

## 집계 결과

| 장면 | 발신 전 | 조치 필요 | 진행 | 안전 | 전화 분모 | 방문 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 평시·감시·확정 대기 | 45 | 0 | 0 | 0 | 45 | 3 |
| 진행 중 | 0 | 11 | 31 | 3 | 45 | 3 |
| 진행 후반 | 0 | 3 | 2 | 40 | 45 | 3 |

구역: 서 10, 북 15, 동 13, 남 10. 4등급 3가구·3등급 12가구. 동의 없음 2와 전화 없음 1은 겹치지 않는다. 90일 초과 3가구, 거동 불명 1가구. 가능 조원 9·불가 3이며 각 조에 가능 운전자가 있다. 수송 자원 9·진화 전용 1. 지도 위치는 구역 경계 안에서 서로 다른 좌표다.

`householdStatuses`에는 householdId, status, lastChangedAt, note와 시연을 위한 attemptCount, acked, visitCompleted, handoffStatus가 있다. 원본의 상태 집계는 데이터 요청 계약에 따른다. 런타임은 pendingunknown/redial을 추가하며 응급 접수 중 상태를 안전에 합치지 않는다. 모든 화면은 `groupOf`와 `tally`를 공유한다. 발령 이후 N+P+K=D, H=D+V+X를 유지한다. 발신 전 45는 별도 before 그룹이다.

`npm test`의 fixture 테스트는 JSON과 bundle 일치, ID 중복, 모든 가구/조/차량/대피소 참조, 가상 연락 식별자, 구역 경계, 등급 규칙, 시나리오 재집계, 로그 시각을 검사한다. 파일을 수정하면 해당 파일과 bundle을 함께 수정해야 한다. source payload는 자체 합성 형식이며 실제 정부 API 응답 스키마라고 주장하지 않는다.
