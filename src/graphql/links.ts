import {
    ArgumentNode, getNamedType, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLOutputType, GraphQLResolveInfo,
    GraphQLSchema, GraphQLType, ListTypeNode, NamedTypeNode, SelectionNode, TypeNode, ValueNode, VariableDefinitionNode
} from 'graphql';
import { FieldTransformationContext, GraphQLNamedFieldConfig, SchemaTransformer } from './schema-transformer';
import { EndpointConfig, LinkConfigMap } from '../config/proxy-configuration';
import { getReverseTypeRenamer, getTypePrefix } from './renaming';
import { resolveAsProxy } from './proxy-resolver';
import DataLoader = require('dataloader');

export class SchemaLinkTransformer implements SchemaTransformer {
    private endpointMap: Map<string, EndpointConfig>;

    constructor(private endpoints: EndpointConfig[], private schema: GraphQLSchema, private links: LinkConfigMap) {
        this.endpointMap = new Map(endpoints.map(endpoint => <[string, EndpointConfig]>[endpoint.name, endpoint]));
    }

    transformField(config: GraphQLNamedFieldConfig<any, any>, context: FieldTransformationContext) {
        const splitTypeName = this.splitTypeName(context.oldOuterType.name);
        if (!splitTypeName) {
            return;
        }

        const endpoint = this.endpointMap.get(splitTypeName.endpoint);
        if (!endpoint) {
            throw new Error(`Endpoint ${splitTypeName.endpoint} not found`);
        }

        const linkName = splitTypeName.originalTypeName + '.' + config.name;
        const link = endpoint.links[linkName];
        if (!link) {
            return;
        }

        const targetEndpoint = this.endpointMap.get(link.endpoint);
        if (!targetEndpoint) {
            throw new Error(`Link ${linkName} refers to nonexistent endpoint ${link.endpoint}`);
        }

        const endpointQueryType = this.schema.getQueryType().getFields()[targetEndpoint.name].type;
        if (!(endpointQueryType instanceof GraphQLObjectType)) {
            throw new Error(`Expected object type as query type of endpoint ${targetEndpoint.name}`);
        }

        const dataLoaders = new WeakMap<any, DataLoader<any, any>>(); // TODO have one dataLoader per selection set

        const varName = 'param';
        const basicResolve = async (value: any, info: GraphQLResolveInfo) => {
            const obj = await resolveAsProxy(info, {
                url: targetEndpoint.url,
                operation: 'query',
                links: this.links,
                typeRenamer: getReverseTypeRenamer(targetEndpoint),
                transform: ({operation, fragments, variables}) => {
                    return {
                        fragments,
                        operation: {
                            ...operation,
                            operation: 'query', // links are always resolved via query operations
                            variableDefinitions: [
                                ...(operation.variableDefinitions || []),
                                createVariableDefinitionNode(varName, link.batchMode ? new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(originalType))) : originalType)
                            ],
                            selectionSet: {
                                kind: 'SelectionSet',
                                selections: [
                                    {
                                        kind: 'Field',
                                        name: {
                                            kind: 'Name',
                                            value: link.field
                                        },
                                        arguments: [
                                            createNestedArgumentWithVariableNode(link.argument, varName)
                                        ],
                                        selectionSet: {
                                            kind: 'SelectionSet',
                                            selections: <SelectionNode[]>[ // strange type error
                                                ...operation.selectionSet.selections,
                                                ...(link.keyField ? [{
                                                    kind: 'Field',
                                                    name: {
                                                        kind: 'Name',
                                                        value: link.keyField
                                                    }
                                                }] : [])
                                            ]
                                        }
                                    }
                                ]
                            }
                        },
                        variables: {
                            ...variables,
                            [varName]: value
                        }
                    };
                }
            });
            return obj[link.field];
        };

        const resolveBatch = async (keys: any[], info: GraphQLResolveInfo) => {
            let result;
            if (link.batchMode) {
                result = await basicResolve(keys, info);
            } else {
                result = await keys.map(key => basicResolve(key, info));
            }

            if (!link.keyField) {
                // simple case: endpoint returns the objects in the order of given ids
                return result;
            }
            // unordered case: endpoints does not preserve order, so we need to remap based on a key field
            const map = new Map((<any[]>result).map(item => <[any, any]>[item[link.keyField], item]));
            return keys.map(key => map.get(key));
        };

        const field = endpointQueryType.getFields()[link.field];
        const originalType = config.type;
        // unwrap list for batch mode, unwrap NonNull because object may be missing -> strip all type wrappers
        config.type = <GraphQLOutputType>getNamedType(context.mapType(field.type));
        config.resolve = async (source, args, context, info) => {
            const fieldNode = info.fieldNodes[0];
            const alias = fieldNode.alias ? fieldNode.alias.value : fieldNode.name.value;
            const value = source[alias];
            if (!value) {
                return value;
            }

            let dataLoader = dataLoaders.get(context);
            if (!dataLoader) {
                dataLoader = new DataLoader(keys => resolveBatch(keys, info));
                dataLoaders.set(context, dataLoader);
            }

            return dataLoader.load(value);
        };
    }

    private splitTypeName(mergedName: string): { endpoint: string, originalTypeName: string } | undefined {
        for (const endpoint of this.endpoints) {
            const prefix = getTypePrefix(endpoint);
            if (mergedName.startsWith(prefix)) {
                return {
                    endpoint: endpoint.name,
                    originalTypeName: mergedName.substr(prefix.length)
                };
            }
        }
        return undefined;
    }
}

function createTypeNode(type: GraphQLType): TypeNode {
    if (type instanceof GraphQLList) {
        return {
            kind: 'ListType',
            type: createTypeNode(type.ofType)
        };
    }
    if (type instanceof GraphQLNonNull) {
        return {
            kind: 'NonNullType',
            type: <NamedTypeNode | ListTypeNode>createTypeNode(type.ofType)
        };
    }
    return {
        kind: 'NamedType',
        name: {
            kind: 'Name',
            value: type.name
        }
    };
}

function createVariableDefinitionNode(varName: string, type: GraphQLType): VariableDefinitionNode {
    return {
        kind: 'VariableDefinition',
        variable: {
            kind: 'Variable',
            name: {
                kind: 'Name',
                value: varName
            }
        },
        type: createTypeNode(type)
    };
}

function createNestedArgumentWithVariableNode(argumentPath: string, variableName: string): ArgumentNode {
    const parts = argumentPath.split('.');
    const argName = parts.shift();
    if (!argName) {
        throw new Error('Argument must not be empty');
    }

    let value: ValueNode = {
        kind: 'Variable',
        name: {
            kind: 'Name',
            value: variableName
        }
    };

    for (const part of parts.reverse()) {
        value = {
            kind: 'ObjectValue',
            fields: [
                {
                    kind: 'ObjectField',
                    value,
                    name: {
                        kind: 'Name',
                        value: part
                    }
                }
            ]
        };
    }

    return {
        kind: 'Argument',
        name: {
            kind: 'Name',
            value: argName
        },
        value
    };
}