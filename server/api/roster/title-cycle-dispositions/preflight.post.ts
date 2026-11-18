import { dispositionRoute } from '../../../../layers/sme-roster/server/utils/title-cycle-disposition-route'

defineRouteMeta({
  "openAPI": {
    "tags": [
      "称号周期处置"
    ],
    "summary": "preflight title-cycle dispositions",
    "description": "Little Giant revisions only. Formal failures reference existing formal events; assert/replace starts pending. Confirm explicitly. Read enterpriseIds as comma-separated IDs.",
    "responses": {
      "200": {
        "description": "Immutable receipt or revision readback"
      },
      "400": {
        "description": "Invalid request"
      },
      "401": {
        "description": "API token required for commands"
      },
      "409": {
        "description": "Version/source/cycle/plan/idempotency conflict"
      },
      "500": {
        "description": "Operation failed; no partial commit"
      }
    },
    "requestBody": {
      "required": true,
      "content": {
        "application/json": {
          "schema": {
            "type": "object",
            "properties": {
              "idempotencyKey": {
                "type": "string",
                "description": "Runtime validation: minLength=1, maxLength=4000"
              },
              "expectedVersion": {
                "type": "string",
                "description": "Runtime validation: minLength=1, maxLength=4000"
              },
              "actor": {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "enum": [
                      "user",
                      "agent"
                    ]
                  },
                  "id": {
                    "type": "string",
                    "description": "Runtime validation: minLength=1, maxLength=4000"
                  }
                },
                "required": [
                  "type",
                  "id"
                ],
                "additionalProperties": false
              },
              "basis": {
                "type": "string",
                "description": "Runtime validation: minLength=1, maxLength=4000"
              },
              "operations": {
                "minItems": 1,
                "maxItems": 100,
                "type": "array",
                "items": {
                  "oneOf": [
                    {
                      "type": "object",
                      "properties": {
                        "action": {
                          "type": "string",
                          "const": "assert"
                        },
                        "enterpriseId": {
                          "type": "integer",
                          "maximum": 9007199254740991,
                          "description": "Runtime validation: exclusiveMinimum=0"
                        },
                        "fact": {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "enum": [
                                "not_applied",
                                "not_recommended",
                                "formal_failure"
                              ]
                            },
                            "source": {
                              "type": "object",
                              "properties": {
                                "fileId": {
                                  "type": "integer",
                                  "maximum": 9007199254740991,
                                  "description": "Runtime validation: exclusiveMinimum=0"
                                },
                                "sha256": {
                                  "type": "string",
                                  "description": "Runtime validation: pattern=^[a-f0-9]{64}$"
                                },
                                "reference": {
                                  "type": "string",
                                  "description": "Runtime validation: minLength=1, maxLength=4000"
                                },
                                "statement": {
                                  "type": "string",
                                  "description": "Runtime validation: minLength=1, maxLength=4000"
                                }
                              },
                              "required": [
                                "fileId",
                                "sha256",
                                "reference",
                                "statement"
                              ],
                              "additionalProperties": false
                            },
                            "cycle": {
                              "anyOf": [
                                {
                                  "type": "object",
                                  "properties": {
                                    "eventId": {
                                      "type": "integer",
                                      "maximum": 9007199254740991,
                                      "description": "Runtime validation: exclusiveMinimum=0"
                                    },
                                    "revision": {
                                      "type": "integer",
                                      "maximum": 9007199254740991,
                                      "description": "Runtime validation: exclusiveMinimum=0"
                                    }
                                  },
                                  "required": [
                                    "eventId",
                                    "revision"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "null"
                                }
                              ],
                              "type": [
                                "object",
                                "null"
                              ]
                            },
                            "formalEvent": {
                              "type": "object",
                              "properties": {
                                "eventId": {
                                  "type": "integer",
                                  "maximum": 9007199254740991,
                                  "description": "Runtime validation: exclusiveMinimum=0"
                                },
                                "revision": {
                                  "type": "integer",
                                  "maximum": 9007199254740991,
                                  "description": "Runtime validation: exclusiveMinimum=0"
                                }
                              },
                              "required": [
                                "eventId",
                                "revision"
                              ],
                              "additionalProperties": false
                            },
                            "observed": {
                              "oneOf": [
                                {
                                  "type": "object",
                                  "properties": {
                                    "precision": {
                                      "type": "string",
                                      "const": "unknown"
                                    },
                                    "value": {
                                      "type": "null"
                                    }
                                  },
                                  "required": [
                                    "precision",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "precision": {
                                      "type": "string",
                                      "const": "year"
                                    },
                                    "value": {
                                      "type": "string",
                                      "description": "Runtime validation: pattern=^\\d{4}$"
                                    }
                                  },
                                  "required": [
                                    "precision",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "precision": {
                                      "type": "string",
                                      "const": "month"
                                    },
                                    "value": {
                                      "type": "string",
                                      "description": "Runtime validation: pattern=^\\d{4}-(0[1-9]|1[0-2])$"
                                    }
                                  },
                                  "required": [
                                    "precision",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "precision": {
                                      "type": "string",
                                      "const": "day"
                                    },
                                    "value": {
                                      "type": "string",
                                      "format": "date",
                                      "description": "Runtime validation: pattern=^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"
                                    }
                                  },
                                  "required": [
                                    "precision",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                }
                              ],
                              "type": "object"
                            },
                            "effective": {
                              "oneOf": [
                                {
                                  "type": "object",
                                  "properties": {
                                    "precision": {
                                      "type": "string",
                                      "const": "unknown"
                                    },
                                    "value": {
                                      "type": "null"
                                    }
                                  },
                                  "required": [
                                    "precision",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "precision": {
                                      "type": "string",
                                      "const": "year"
                                    },
                                    "value": {
                                      "type": "string",
                                      "description": "Runtime validation: pattern=^\\d{4}$"
                                    }
                                  },
                                  "required": [
                                    "precision",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "precision": {
                                      "type": "string",
                                      "const": "month"
                                    },
                                    "value": {
                                      "type": "string",
                                      "description": "Runtime validation: pattern=^\\d{4}-(0[1-9]|1[0-2])$"
                                    }
                                  },
                                  "required": [
                                    "precision",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "precision": {
                                      "type": "string",
                                      "const": "day"
                                    },
                                    "value": {
                                      "type": "string",
                                      "format": "date",
                                      "description": "Runtime validation: pattern=^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"
                                    }
                                  },
                                  "required": [
                                    "precision",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                }
                              ],
                              "type": "object"
                            },
                            "effectiveBasis": {
                              "anyOf": [
                                {
                                  "type": "string",
                                  "description": "Runtime validation: minLength=1, maxLength=4000"
                                },
                                {
                                  "type": "null"
                                }
                              ],
                              "type": [
                                "string",
                                "null"
                              ]
                            }
                          },
                          "required": [
                            "kind",
                            "source",
                            "cycle",
                            "observed",
                            "effective",
                            "effectiveBasis"
                          ],
                          "additionalProperties": false
                        }
                      },
                      "required": [
                        "action",
                        "enterpriseId",
                        "fact"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "action": {
                          "type": "string",
                          "const": "replace"
                        },
                        "id": {
                          "type": "string",
                          "description": "Runtime validation: minLength=1, maxLength=4000"
                        },
                        "revision": {
                          "type": "integer",
                          "maximum": 9007199254740991,
                          "description": "Runtime validation: exclusiveMinimum=0"
                        },
                        "fact": {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "enum": [
                                "not_applied",
                                "not_recommended",
                                "formal_failure"
                              ]
                            },
                            "source": {
                              "type": "object",
                              "properties": {
                                "fileId": {
                                  "type": "integer",
                                  "maximum": 9007199254740991,
                                  "description": "Runtime validation: exclusiveMinimum=0"
                                },
                                "sha256": {
                                  "type": "string",
                                  "description": "Runtime validation: pattern=^[a-f0-9]{64}$"
                                },
                                "reference": {
                                  "type": "string",
                                  "description": "Runtime validation: minLength=1, maxLength=4000"
                                },
                                "statement": {
                                  "type": "string",
                                  "description": "Runtime validation: minLength=1, maxLength=4000"
                                }
                              },
                              "required": [
                                "fileId",
                                "sha256",
                                "reference",
                                "statement"
                              ],
                              "additionalProperties": false
                            },
                            "cycle": {
                              "anyOf": [
                                {
                                  "type": "object",
                                  "properties": {
                                    "eventId": {
                                      "type": "integer",
                                      "maximum": 9007199254740991,
                                      "description": "Runtime validation: exclusiveMinimum=0"
                                    },
                                    "revision": {
                                      "type": "integer",
                                      "maximum": 9007199254740991,
                                      "description": "Runtime validation: exclusiveMinimum=0"
                                    }
                                  },
                                  "required": [
                                    "eventId",
                                    "revision"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "null"
                                }
                              ],
                              "type": [
                                "object",
                                "null"
                              ]
                            },
                            "formalEvent": {
                              "type": "object",
                              "properties": {
                                "eventId": {
                                  "type": "integer",
                                  "maximum": 9007199254740991,
                                  "description": "Runtime validation: exclusiveMinimum=0"
                                },
                                "revision": {
                                  "type": "integer",
                                  "maximum": 9007199254740991,
                                  "description": "Runtime validation: exclusiveMinimum=0"
                                }
                              },
                              "required": [
                                "eventId",
                                "revision"
                              ],
                              "additionalProperties": false
                            },
                            "observed": {
                              "oneOf": [
                                {
                                  "type": "object",
                                  "properties": {
                                    "precision": {
                                      "type": "string",
                                      "const": "unknown"
                                    },
                                    "value": {
                                      "type": "null"
                                    }
                                  },
                                  "required": [
                                    "precision",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "precision": {
                                      "type": "string",
                                      "const": "year"
                                    },
                                    "value": {
                                      "type": "string",
                                      "description": "Runtime validation: pattern=^\\d{4}$"
                                    }
                                  },
                                  "required": [
                                    "precision",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "precision": {
                                      "type": "string",
                                      "const": "month"
                                    },
                                    "value": {
                                      "type": "string",
                                      "description": "Runtime validation: pattern=^\\d{4}-(0[1-9]|1[0-2])$"
                                    }
                                  },
                                  "required": [
                                    "precision",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "precision": {
                                      "type": "string",
                                      "const": "day"
                                    },
                                    "value": {
                                      "type": "string",
                                      "format": "date",
                                      "description": "Runtime validation: pattern=^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"
                                    }
                                  },
                                  "required": [
                                    "precision",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                }
                              ],
                              "type": "object"
                            },
                            "effective": {
                              "oneOf": [
                                {
                                  "type": "object",
                                  "properties": {
                                    "precision": {
                                      "type": "string",
                                      "const": "unknown"
                                    },
                                    "value": {
                                      "type": "null"
                                    }
                                  },
                                  "required": [
                                    "precision",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "precision": {
                                      "type": "string",
                                      "const": "year"
                                    },
                                    "value": {
                                      "type": "string",
                                      "description": "Runtime validation: pattern=^\\d{4}$"
                                    }
                                  },
                                  "required": [
                                    "precision",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "precision": {
                                      "type": "string",
                                      "const": "month"
                                    },
                                    "value": {
                                      "type": "string",
                                      "description": "Runtime validation: pattern=^\\d{4}-(0[1-9]|1[0-2])$"
                                    }
                                  },
                                  "required": [
                                    "precision",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "precision": {
                                      "type": "string",
                                      "const": "day"
                                    },
                                    "value": {
                                      "type": "string",
                                      "format": "date",
                                      "description": "Runtime validation: pattern=^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"
                                    }
                                  },
                                  "required": [
                                    "precision",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                }
                              ],
                              "type": "object"
                            },
                            "effectiveBasis": {
                              "anyOf": [
                                {
                                  "type": "string",
                                  "description": "Runtime validation: minLength=1, maxLength=4000"
                                },
                                {
                                  "type": "null"
                                }
                              ],
                              "type": [
                                "string",
                                "null"
                              ]
                            }
                          },
                          "required": [
                            "kind",
                            "source",
                            "cycle",
                            "observed",
                            "effective",
                            "effectiveBasis"
                          ],
                          "additionalProperties": false
                        }
                      },
                      "required": [
                        "action",
                        "id",
                        "revision",
                        "fact"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "action": {
                          "type": "string",
                          "const": "confirm"
                        },
                        "id": {
                          "type": "string",
                          "description": "Runtime validation: minLength=1, maxLength=4000"
                        },
                        "revision": {
                          "type": "integer",
                          "maximum": 9007199254740991,
                          "description": "Runtime validation: exclusiveMinimum=0"
                        }
                      },
                      "required": [
                        "action",
                        "id",
                        "revision"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "action": {
                          "type": "string",
                          "const": "withdraw"
                        },
                        "id": {
                          "type": "string",
                          "description": "Runtime validation: minLength=1, maxLength=4000"
                        },
                        "revision": {
                          "type": "integer",
                          "maximum": 9007199254740991,
                          "description": "Runtime validation: exclusiveMinimum=0"
                        }
                      },
                      "required": [
                        "action",
                        "id",
                        "revision"
                      ],
                      "additionalProperties": false
                    }
                  ],
                  "type": "object"
                }
              }
            },
            "required": [
              "idempotencyKey",
              "expectedVersion",
              "actor",
              "basis",
              "operations"
            ],
            "additionalProperties": false
          }
        }
      }
    }
  }
})
export default dispositionRoute('preflight')
