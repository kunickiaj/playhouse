import { get, isEqual } from 'lodash';
import { connectionFromArray } from 'graphql-relay';
import { Entity, parseEntityRef } from '@backstage/catalog-model';
import { getDirective, MapperKind, addTypes, mapSchema, getImplementingTypes } from '@graphql-tools/utils';
import {
  GraphQLFieldConfig,
  GraphQLFieldConfigMap,
  GraphQLID,
  GraphQLInt,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNamedType,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLSchema,
  GraphQLString,
  GraphQLTypeResolver,
  GraphQLUnionType,
  isInputType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isUnionType,
} from 'graphql';
import type { ResolverContext } from './types';

function filterEntities(entity: Entity | undefined, relationName: string, targetKind?: string): { id: string }[] {
  return entity
    ?.relations
    ?.filter(({ type, targetRef }) => {
      const { kind } = parseEntityRef(targetRef)
      return type === relationName && (targetKind ? kind.toLowerCase() === targetKind.toLowerCase() : true)
    })
    .map(({ targetRef }) => ({ id: targetRef })) ?? [];
}

function isConnectionType(type: unknown): type is GraphQLInterfaceType {
  return isInterfaceType(type) && type.name === 'Connection'
  || isNonNullType(type) && isConnectionType(type.ofType);
}

function createConnectionType(
  typeName: string,
  fieldType: GraphQLInterfaceType,
  nodeType: GraphQLOutputType,
): GraphQLObjectType {
  const wrappedEdgeType = fieldType.getFields().edges.type as GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInterfaceType>>>
  const edgeType = wrappedEdgeType.ofType.ofType.ofType as GraphQLInterfaceType

  return new GraphQLObjectType({
    name: `${typeName}Connection`,
    fields: {
      ...fieldType.toConfig().fields,
      edges: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(new GraphQLObjectType({
          name: `${typeName}Edge`,
          fields: {
            ...edgeType.toConfig().fields,
            node: {
              type: new GraphQLNonNull(nodeType as GraphQLOutputType),
            }
          },
          interfaces: [edgeType]
        }))))
      }
    },
    interfaces: [fieldType]
  })
}

export function transformDirectives(sourceSchema: GraphQLSchema) {
  const extendsWithoutArgs = new Set<string>();
  const resolversMap: Record<string, GraphQLTypeResolver<any, any>> = {}
  const typesToAdd = new Map<string, GraphQLNamedType>()
  const additionalInterfaces: Record<string, Set<GraphQLInterfaceType>> = {};

  function handleFieldDirective(field: GraphQLFieldConfig<{ id: string }, ResolverContext>, directive: Record<string, any>) {
    if (typeof directive.at !== 'string' || (Array.isArray(directive.at) && directive.at.every(a => typeof a !== 'string'))) {
      throw new Error(`The "at" argument of @field directive must be a string or an array of strings`);
    }
    field.resolve = async ({ id }, _, { loader }) => {
      const entity = await loader.load(id);
      if (!entity) return null;
      return get(entity, directive.at);
    };
  }

  function handleRelationDirective(
    field: GraphQLFieldConfig<{ id: string }, ResolverContext>,
    fieldName: string,
    directive: Record<string, any>,
    schema: GraphQLSchema
  ) {
    const fieldType = field.type;
    if (
      isListType(fieldType) && isConnectionType(fieldType.ofType)
      || isNonNullType(fieldType) && isListType(fieldType.ofType) && isConnectionType(fieldType.ofType.ofType)
      ) {
        throw new Error(`It's not possible to use a list of Connection type. Use either Connection type or list of specific type`)
      }
    const isList = isListType(fieldType) || (isNonNullType(fieldType) && isListType(fieldType.ofType))

    if (isConnectionType(fieldType)) {
      if (directive.type) {
        const nodeType = schema.getType(directive.type)

        if (!nodeType) {
          throw new Error(`The type "${directive.type}" is not defined in the schema.`)
        }
        if (isInputType(nodeType)) {
          throw new Error(`The type "${directive.type}" is an input type and can't be used as a node type.`)
        }
        if (isUnionType(nodeType)) {
          const iface = (typesToAdd.get(directive.type) ?? new GraphQLInterfaceType({
            name: directive.type,
            interfaces: [schema.getType('Node') as GraphQLInterfaceType],
            fields: { id: { type: new GraphQLNonNull(GraphQLID) } },
            resolveType: (...args) => resolversMap.Node(...args)
          })) as GraphQLInterfaceType
          typesToAdd.set(directive.type, iface)
          nodeType.getTypes().forEach(type => {
            additionalInterfaces[type.name] = (additionalInterfaces[type.name] ?? new Set()).add(iface)
          })
          field.type = createConnectionType(directive.type, fieldType, iface)
        } else {
          field.type = createConnectionType(directive.type, fieldType, nodeType)
        }
      }
      const mandatoryArgs: [string, string][] = [
        ['first', 'Int'],
        ['after', 'String'],
        ['last', 'Int'],
        ['before', 'String'],
      ]

      const args = { ...field.args }
      mandatoryArgs.forEach(([name, type]) => {
        if (name in args) {
          const argType = args[name].type
          if ((isNonNullType(argType) ? argType.ofType.toString() : argType.name) !== type) {
            throw new Error(`The field has mandatory argument "${name}" with different type than expected. Expected: ${type}`)
          }
        }
        args[name] = { type: type === 'Int' ? GraphQLInt : GraphQLString }
      })
      field.args = args

      field.resolve = async ({ id }, args, { loader }) => {
        const entities = filterEntities(await loader.load(id), directive.name ?? fieldName, directive.kind);
        return connectionFromArray(entities, args);
      };
    } else {
      field.resolve = async ({ id }, _, { loader }) => {
        const entities = filterEntities(await loader.load(id), directive.name ?? fieldName, directive.kind);
        return isList ? entities : entities[0] ?? null;
      }
    }
  }

  function validateExtendDirective(directive: Record<string, any>) {
    if ('when' in directive !== 'is' in directive) {
      throw new Error(`The @extend directive of "${directive.type}" should have both "when" and "is" arguments or none of them`)
    }
    if (!('when' in directive) && 'type' in directive && extendsWithoutArgs.has(directive.type)) {
      throw new Error(`The @extend directive of "${directive.type}" without "when" and "is" arguments could be used only once`)
    } else {
      extendsWithoutArgs.add(directive.type)
    }
    if ('when' in directive && (typeof directive.when !== 'string' || (Array.isArray(directive.when) && directive.when.some(a => typeof a !== 'string')))) {
      throw new Error(`The "when" argument of @extend directive should be a string or an array of strings`)
    }
  }

  function defineResolver(type: GraphQLInterfaceType, extendDirective: Record<string, any>, schema: GraphQLSchema) {
    if (!resolversMap[type.name]) resolversMap[type.name] = () => `${type.name}Impl`

    const extendType = schema.getType(extendDirective.type)
    if (!extendType) return

    const resolveType = resolversMap[extendType.name] ?? (
      extendType.name === 'Node'
      ? () => undefined
      : () => `${extendType?.name}Impl`
    )
    resolversMap[extendType.name] = async (source: { id: string }, context: ResolverContext, info, abstractType) => {
      if ('when' in extendDirective && 'is' in extendDirective) {
        const { id } = source;
        const { loader } = context;
        const entity = await loader.load(id)
        if (!entity) return undefined
        if (isEqual(get(entity, extendDirective.when), extendDirective.is)) {
          return resolversMap[type.name]?.(source, context, info, abstractType) ?? undefined
        }
        return resolveType(source, context, info, abstractType) ?? undefined
      }
      return resolversMap[type.name]?.(source, context, info, abstractType) ?? undefined
    }
  }

  const finalSchema = mapSchema(addTypes(mapSchema(mapSchema(sourceSchema, {
    [MapperKind.COMPOSITE_FIELD]: (fieldConfig, fieldName, typeName, schema) => {
      const [fieldDirective] = getDirective(schema, fieldConfig, 'field') ?? []
      const [relationDirective] = getDirective(schema, fieldConfig, 'relation') ?? []

      if (fieldDirective && relationDirective) {
        throw new Error(`The field "${fieldName}" of "${typeName}" type has both @field and @relation directives at the same time`)
      }

      try {
        if (fieldDirective) {
          handleFieldDirective(fieldConfig, fieldDirective)
        } else if (relationDirective) {
          handleRelationDirective(fieldConfig, fieldName, relationDirective, schema)
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : error
        throw new Error(`Error while processing directives on field "${fieldName}" of "${typeName}":\n${errorMessage}`)
      }
      return fieldConfig;
    }
  }), {
    [MapperKind.INTERFACE_TYPE]: (interfaceType, schema) => {
      if (interfaceType.name === 'Node') {
        interfaceType.resolveType = (...args) => resolversMap[interfaceType.name](...args)
      }
      const [extendDirective] = getDirective(schema, interfaceType, 'extend') ?? []
      if (!extendDirective) return interfaceType;
      validateExtendDirective(extendDirective)
      defineResolver(interfaceType, extendDirective, schema)

      const extendInterfaces = traverseExtends(interfaceType, schema)
      const interfaces = [...new Map([
        ...additionalInterfaces[interfaceType.name]?.values() ?? [],
        ...extendInterfaces.flatMap(iface => [...additionalInterfaces[iface.name]?.values() ?? []]),
        ...extendInterfaces
      ].map(iface => [iface.name, iface])).values()]
      const fields = [...interfaces].reverse().reduce((acc, type) => ({ ...acc, ...type.toConfig().fields }), { } as GraphQLFieldConfigMap<any, any>)

      const { astNode, extensionASTNodes, ...typeConfig } = interfaceType.toConfig();

      typesToAdd.set(`${interfaceType.name}Impl`, new GraphQLObjectType({ ...typeConfig, name: `${interfaceType.name}Impl`, fields, interfaces }))

      return new GraphQLInterfaceType({
        ...typeConfig,
        fields,
        resolveType: (...args) => resolversMap[interfaceType.name](...args),
        interfaces: interfaces.filter(iface => iface.name !== interfaceType.name)
      });
    }
  }), [...typesToAdd.values()]), {
    [MapperKind.UNION_TYPE]: (unionType, schema) => {
      const typeConfig = unionType.toConfig()
      if (
        !typeConfig.types.some(type => (
          isInterfaceType(type) &&
          (type as GraphQLInterfaceType).name in resolversMap
        ))
      ) return unionType;

      typeConfig.types = typeConfig.types.flatMap(type => {
        if (isInterfaceType(type)) {
          return getImplementingTypes((type as GraphQLInterfaceType).name, schema).map(name => schema.getType(name) as GraphQLObjectType)
        }
        return [type]
      })
      typeConfig.resolveType = (...args) => resolversMap.Node(...args)
      return new GraphQLUnionType(typeConfig)
    }
  })
  return finalSchema
}

function traverseExtends(type: GraphQLInterfaceType, schema: GraphQLSchema): GraphQLInterfaceType[] {
  const [extendDirective] = getDirective(schema, type, 'extend') ?? []
  const interfaces = [type, ...type.getInterfaces().flatMap(iface => traverseExtends(iface, schema))]
  if (extendDirective && 'type' in extendDirective) {
    const extendType = schema.getType(extendDirective.type)
    if (!isInterfaceType(extendType)) {
      throw new Error(`"${extendDirective.type}" type described in @extend directive for "${type.name}" isn't abstract type or doesn't exist`)
    }
    if (interfaces.includes(extendType)) {
      throw new Error(`The interface "${extendDirective.type}" described in @extend directive for "${type.name}" is already implemented`)
    }

    interfaces.push(...traverseExtends(extendType, schema))
  }
  return interfaces
}
