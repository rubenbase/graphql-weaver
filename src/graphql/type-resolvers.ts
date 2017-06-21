import { SchemaTransformationContext, SchemaTransformer } from './schema-transformer';
import { GraphQLObjectType, GraphQLObjectTypeConfig, GraphQLTypeResolver } from 'graphql';

/**
 * A transformer that adds type resolvers to abstract types. They will assume the __typename field is fetched and use
 * that to locate the concrete type.
 */
export class TypeResolversTransformer implements SchemaTransformer {
    transformObjectType(config: GraphQLObjectTypeConfig<any, any>) {
        config.isTypeOf = undefined;
    }

    transformInterfaceType = this.transformAbstractType;
    transformUnionType = this.transformAbstractType;

    transformAbstractType(config: {name: string, resolveType?: GraphQLTypeResolver<any, any>}, context: SchemaTransformationContext) {
        config.resolveType = async obj => {
            if (!('__typename' in obj)) {
                throw new Error(`__typename does not exist on fetched object of abstract type ${config.name}`);
            }

            // endpoint mapping and type prefixes should be taken care of in the links and type-prefixes modules
            const name = obj.__typename;
            const type = context.findType(name);
            if (!type) {
                throw new Error(`__typename of abstract type ${config.name} is set to ${JSON.stringify(name)}, ` +
                    `but there is no type with that name`);
            }
            if (!(type instanceof GraphQLObjectType)) {
                throw new Error(`__typename of abstract type ${config.name} is set to ${JSON.stringify(name)}, ` +
                    `but that is a ${type.constructor.name} and not a GraphQLObjectType.`);
            }
            return type;
        };
    }
}
