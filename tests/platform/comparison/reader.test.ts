import {expect,it} from 'vitest'
import {comparePlatformComparison,type CandidateComparisonInput} from '../../../lib/roster/platform-comparison'
import {createCurrentQualificationAssessmentReader,QUALIFICATION_ASSESSMENT_VERSION} from '../../../lib/roster/current-qualification'
import * as schema from '../../../db/schema'
import {nativeImportDb,businessSource,commitNativeSource} from '../../roster/imports/fixtures/native-import'

const NULL_ORIGIN_ORACLE = {
  "version": "platform-comparison-410-v1",
  "legacy": {
    "enterpriseId": 1,
    "asOf": "2026-06-01T00:00:00.000Z",
    "ruleVersion": "current-roster-116-v8",
    "assessmentVersion": "enterprise-qualification-407-v1",
    "snapshotId": "c6f5dbbd184deaa354405b92176b0fc055d74e20c10e7a24c1d6fd481f70a110",
    "titles": [
      {
        "titleCode": "little_giant",
        "group": "pending",
        "cycles": [],
        "versions": {
          "facts": "ca196556529bf6b9e0a8645d689a8511d61a4ec2a92406d94b08b7dbef067a9e",
          "sources": "5ae1625b488b3935122d8dd627fe575b388a5aa360378fa4407aad08baaed1e2",
          "decisions": "5ae1625b488b3935122d8dd627fe575b388a5aa360378fa4407aad08baaed1e2",
          "observations": "fde5898c71060f1c5aadf68018968f659c530e2a88ab3d1493e06a7a7dda95d8"
        },
        "officialQualification": {
          "group": "pending",
          "message": "正式资格待核；已有公布及具体缺口保留",
          "basis": "",
          "notes": [
            "缺少已确认认定及资格依据；平台状态或候选对应不能单独证明资格"
          ]
        },
        "subject": {
          "status": "not_established",
          "message": "未见可适用的已确认主体终止事实；不据此证明存续",
          "decisionIds": []
        },
        "region": {
          "status": "not_established",
          "message": "未见可适用的迁移决定；沿用正式公布地域范围",
          "decisionIds": []
        },
        "platform": {
          "status": "not_queried",
          "comparison": "not_established",
          "message": "截至评估时点尚无可适用平台查询；其它观察保留",
          "truncated": false,
          "observations": []
        },
        "correspondence": {
          "status": "unmatched",
          "message": "尚无已确认对应；不据此否定正式资格",
          "refs": []
        },
        "completeness": {
          "status": "recorded",
          "message": "既有字段已记录；未推断具体有效日或未录入的政策条款",
          "gaps": [],
          "publishedNames": [],
          "eventIds": [],
          "fieldGaps": []
        },
        "evidence": [],
        "sourceVersions": [],
        "references": [],
        "notes": [
          "缺少已确认认定及资格依据；平台状态或候选对应不能单独证明资格"
        ],
        "shadow": {
          "legacyGroup": "pending",
          "difference": null
        }
      },
      {
        "titleCode": "specialized_sme",
        "group": "eligible",
        "cycles": [
          {
            "originYear": 2024,
            "batchSeq": 1,
            "precision": "year"
          }
        ],
        "versions": {
          "facts": "285152a22cdf32253a562cb51d98d0cf1394cd5e6a3f48c5bc5e14ac44c1c510",
          "sources": "8241fd8584a6a62efdc0d2c4dc3cc2958e9ec794c7d7bcae5cfa0bbcdb7072c7",
          "decisions": "5ae1625b488b3935122d8dd627fe575b388a5aa360378fa4407aad08baaed1e2",
          "observations": "fde5898c71060f1c5aadf68018968f659c530e2a88ab3d1493e06a7a7dda95d8"
        },
        "officialQualification": {
          "group": "eligible",
          "message": "正式资格当前有效（按已录入的年份或已核实有效期间）",
          "basis": "event:1@1 award /1 结论年:2024",
          "notes": []
        },
        "subject": {
          "status": "not_established",
          "message": "未见可适用的已确认主体终止事实；不据此证明存续",
          "decisionIds": []
        },
        "region": {
          "status": "not_established",
          "message": "未见可适用的迁移决定；沿用正式公布地域范围",
          "decisionIds": []
        },
        "platform": {
          "status": "not_queried",
          "comparison": "not_established",
          "message": "截至评估时点尚无可适用平台查询；其它观察保留",
          "truncated": false,
          "observations": []
        },
        "correspondence": {
          "status": "unmatched",
          "message": "尚无已确认对应；不据此否定正式资格",
          "refs": []
        },
        "completeness": {
          "status": "recorded",
          "message": "既有字段已记录；未推断具体有效日或未录入的政策条款",
          "gaps": [],
          "publishedNames": [
            {
              "evidenceId": 1,
              "availability": "captured",
              "nameKnown": true
            }
          ],
          "eventIds": [],
          "fieldGaps": [
            {
              "eventId": 1,
              "field": "year",
              "valueState": "unknown",
              "inputState": "null"
            }
          ]
        },
        "evidence": [
          {
            "eventId": 1,
            "revision": 1,
            "eventType": "award",
            "year": null,
            "batchSeq": 1,
            "decidedYear": 2024,
            "reviewOutcome": null,
            "evidenceIds": [
              1
            ]
          }
        ],
        "sourceVersions": [
          {
            "evidenceId": 1,
            "eventId": 1,
            "sourceFile": "synthetic/null-year-427.pdf",
            "storedFileId": 1,
            "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "bytes": 10,
            "removedAt": null,
            "capturedRevision": 1,
            "capturedSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        ],
        "references": [
          "evidence:1 synthetic/null-year-427.pdf  序号:1"
        ],
        "notes": [],
        "shadow": {
          "legacyGroup": "eligible",
          "difference": null
        }
      },
      {
        "titleCode": "innovative_sme",
        "group": "pending",
        "cycles": [],
        "versions": {
          "facts": "ca196556529bf6b9e0a8645d689a8511d61a4ec2a92406d94b08b7dbef067a9e",
          "sources": "5ae1625b488b3935122d8dd627fe575b388a5aa360378fa4407aad08baaed1e2",
          "decisions": "5ae1625b488b3935122d8dd627fe575b388a5aa360378fa4407aad08baaed1e2",
          "observations": "fde5898c71060f1c5aadf68018968f659c530e2a88ab3d1493e06a7a7dda95d8"
        },
        "officialQualification": {
          "group": "pending",
          "message": "正式资格待核；已有公布及具体缺口保留",
          "basis": "",
          "notes": [
            "缺少已确认认定及资格依据；平台状态或候选对应不能单独证明资格"
          ]
        },
        "subject": {
          "status": "not_established",
          "message": "未见可适用的已确认主体终止事实；不据此证明存续",
          "decisionIds": []
        },
        "region": {
          "status": "not_established",
          "message": "未见可适用的迁移决定；沿用正式公布地域范围",
          "decisionIds": []
        },
        "platform": {
          "status": "not_queried",
          "comparison": "not_established",
          "message": "截至评估时点尚无可适用平台查询；其它观察保留",
          "truncated": false,
          "observations": []
        },
        "correspondence": {
          "status": "unmatched",
          "message": "尚无已确认对应；不据此否定正式资格",
          "refs": []
        },
        "completeness": {
          "status": "recorded",
          "message": "既有字段已记录；未推断具体有效日或未录入的政策条款",
          "gaps": [],
          "publishedNames": [],
          "eventIds": [],
          "fieldGaps": []
        },
        "evidence": [],
        "sourceVersions": [],
        "references": [],
        "notes": [
          "缺少已确认认定及资格依据；平台状态或候选对应不能单独证明资格"
        ],
        "shadow": {
          "legacyGroup": "pending",
          "difference": null
        }
      }
    ]
  },
  "titleCode": "specialized_sme",
  "formal": {
    "assessment": {
      "titleCode": "specialized_sme",
      "group": "eligible",
      "officialQualification": {
        "group": "eligible",
        "message": "正式资格当前有效（按已录入的年份或已核实有效期间）",
        "basis": "event:1@1 award /1 结论年:2024",
        "notes": []
      },
      "subject": {
        "status": "not_established",
        "message": "未见可适用的已确认主体终止事实；不据此证明存续",
        "decisionIds": []
      },
      "region": {
        "status": "not_established",
        "message": "未见可适用的迁移决定；沿用正式公布地域范围",
        "decisionIds": []
      },
      "cycles": [
        {
          "originYear": 2024,
          "batchSeq": 1,
          "precision": "year"
        }
      ],
      "versions": {
        "facts": "285152a22cdf32253a562cb51d98d0cf1394cd5e6a3f48c5bc5e14ac44c1c510",
        "sources": "8241fd8584a6a62efdc0d2c4dc3cc2958e9ec794c7d7bcae5cfa0bbcdb7072c7",
        "decisions": "5ae1625b488b3935122d8dd627fe575b388a5aa360378fa4407aad08baaed1e2",
        "observations": "fde5898c71060f1c5aadf68018968f659c530e2a88ab3d1493e06a7a7dda95d8"
      },
      "evidence": [
        {
          "eventId": 1,
          "revision": 1,
          "eventType": "award",
          "year": null,
          "batchSeq": 1,
          "decidedYear": 2024,
          "reviewOutcome": null,
          "evidenceIds": [
            1
          ]
        }
      ],
      "sourceVersions": [
        {
          "evidenceId": 1,
          "eventId": 1,
          "sourceFile": "synthetic/null-year-427.pdf",
          "storedFileId": 1,
          "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "bytes": 10,
          "removedAt": null,
          "capturedRevision": 1,
          "capturedSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }
      ],
      "completeness": {
        "status": "recorded",
        "message": "既有字段已记录；未推断具体有效日或未录入的政策条款",
        "gaps": [],
        "publishedNames": [
          {
            "evidenceId": 1,
            "availability": "captured",
            "nameKnown": true
          }
        ],
        "eventIds": [],
        "fieldGaps": [
          {
            "eventId": 1,
            "field": "year",
            "valueState": "unknown",
            "inputState": "null"
          }
        ]
      },
      "correspondence": {
        "status": "unmatched",
        "message": "尚无已确认对应；不据此否定正式资格",
        "refs": []
      }
    },
    "cycles": [
      {
        "cycle": {
          "originYear": 2024,
          "batchSeq": 1,
          "precision": "year"
        },
        "judgment": {
          "anchor": {
            "id": 1,
            "eventType": "award",
            "year": null,
            "decidedYear": 2024,
            "batchSeq": 1,
            "reviewOutcome": null,
            "revision": 1,
            "nameRaw": "合成427空原年",
            "usccRaw": "91330211255994457P",
            "source": "jxj"
          },
          "originYear": 2024,
          "batch": 1,
          "group": "eligible",
          "awardEventIds": [
            1
          ]
        },
        "eventIds": [
          1
        ]
      }
    ]
  },
  "queries": {
    "sources": [],
    "truncated": false
  },
  "processes": []
}

it('keeps the independent null-origin literal comparison without inventing a platform observation',()=>{
 const before=JSON.stringify(NULL_ORIGIN_ORACLE)
 const result=comparePlatformComparison(NULL_ORIGIN_ORACLE as CandidateComparisonInput)
 expect(result.observation.state).toBe('not_queried')
 expect(result.comparison.state).toBe('not_established')
 expect(result.comparison.cycles[0]!.reasons).toEqual(['not_queried'])
 expect(JSON.stringify(NULL_ORIGIN_ORACLE)).toBe(before)
})
it('reads native source observations without granting formal qualification or changing stored facts',()=>{
 const db=nativeImportDb()
 try{
 const e=db.insert(schema.enterprise).values({name:'Native comparison',nameNorm:'native comparison',usccNorm:'91330211255994457P'}).returning().get()
 const reader=createCurrentQualificationAssessmentReader(db.$client),at=Date.parse('2026-06-01T00:00:00Z')
 const before=reader.read(e.id,at).snapshot
 expect(before.assessmentVersion).toBe(QUALIFICATION_ASSESSMENT_VERSION)
 expect(before.titles.map(t=>t.group)).toEqual(['excluded','excluded','excluded'])
 expect(commitNativeSource(db,businessSource(e.usccNorm!), 'native-comparison').status).toBe('committed')
 const stored=db.$client.serialize(),actual=reader.read(e.id,at).snapshot
 expect(actual.titles.map(t=>t.group)).toEqual(['excluded','excluded','excluded'])
 expect(actual.titles.find(t=>t.titleCode==='specialized_sme')!.platform.observations).toHaveLength(1)
 expect(db.$client.serialize().equals(stored)).toBe(true)
 }finally{db.$client.close()}
})
