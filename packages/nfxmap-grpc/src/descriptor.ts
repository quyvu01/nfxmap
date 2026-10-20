// Generated from proto/fxMap.proto by scripts/descriptor.mjs: do not edit.
export const FXMAP_DESCRIPTOR = {
    "options": {
        "csharp_namespace": "FxMap.Grpc"
    },
    "nested": {
        "FxMapTransport": {
            "nested": {
                "FxMapTransportService": {
                    "methods": {
                        "GetItems": {
                            "requestType": "GetFxMapGrpcQuery",
                            "responseType": "FxMapItemsGrpcResponse"
                        },
                        "GetDistributedKeys": {
                            "requestType": "GetDistributedKeysQuery",
                            "responseType": "DistributedKeyTypeResponse"
                        }
                    }
                },
                "GetFxMapGrpcQuery": {
                    "fields": {
                        "selector_ids": {
                            "rule": "repeated",
                            "type": "string",
                            "id": 1
                        },
                        "expression": {
                            "type": "google.protobuf.StringValue",
                            "id": 2
                        },
                        "distributed_key_assembly_type": {
                            "type": "google.protobuf.StringValue",
                            "id": 3
                        }
                    }
                },
                "ExpressionErrorGrpc": {
                    "fields": {
                        "expression": {
                            "type": "google.protobuf.StringValue",
                            "id": 1
                        },
                        "message": {
                            "type": "google.protobuf.StringValue",
                            "id": 2
                        }
                    }
                },
                "FxMapItemsGrpcResponse": {
                    "fields": {
                        "items": {
                            "rule": "repeated",
                            "type": "ItemGrpc",
                            "id": 1
                        },
                        "errors": {
                            "rule": "repeated",
                            "type": "ExpressionErrorGrpc",
                            "id": 2
                        }
                    }
                },
                "GetDistributedKeysQuery": {
                    "fields": {}
                },
                "DistributedKeyTypeResponse": {
                    "fields": {
                        "distributed_key_types": {
                            "rule": "repeated",
                            "type": "string",
                            "id": 1
                        }
                    }
                },
                "ItemGrpc": {
                    "fields": {
                        "id": {
                            "type": "string",
                            "id": 1
                        },
                        "fxmap_values": {
                            "rule": "repeated",
                            "type": "FxMapValueItemGrpc",
                            "id": 2
                        }
                    }
                },
                "FxMapValueItemGrpc": {
                    "fields": {
                        "expression": {
                            "type": "google.protobuf.StringValue",
                            "id": 1
                        },
                        "value": {
                            "type": "google.protobuf.StringValue",
                            "id": 2
                        }
                    }
                }
            }
        },
        "google": {
            "nested": {
                "protobuf": {
                    "nested": {
                        "StringValue": {
                            "fields": {
                                "value": {
                                    "type": "string",
                                    "id": 1
                                }
                            }
                        }
                    }
                }
            }
        }
    }
} as const;
