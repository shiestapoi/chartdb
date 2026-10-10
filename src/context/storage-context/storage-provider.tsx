import React, { useCallback, useEffect } from 'react';
import type { StorageContext } from './storage-context';
import { storageContext } from './storage-context';
import type { Diagram } from '@/lib/domain/diagram';
import type { DBTable } from '@/lib/domain/db-table';
import type { DBRelationship } from '@/lib/domain/db-relationship';
import type { ChartDBConfig } from '@/lib/domain/config';
import type { DBDependency } from '@/lib/domain/db-dependency';
import type { Area } from '@/lib/domain/area';
import type { DBCustomType } from '@/lib/domain/db-custom-type';
import type { DiagramFilter } from '@/lib/domain/diagram-filter/diagram-filter';
import type { Note } from '@/lib/domain/note';

const API_BASE: string =
    (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api';

const COLLECTIONS = {
    diagrams: 'diagrams',
    tables: 'db_tables',
    relationships: 'db_relationships',
    dependencies: 'db_dependencies',
    areas: 'areas',
    customTypes: 'db_custom_types',
    notes: 'notes',
    config: 'config',
    diagramFilters: 'diagram_filters',
} as const;

const DIAGRAM_SCOPED_COLLECTIONS = [
    COLLECTIONS.tables,
    COLLECTIONS.relationships,
    COLLECTIONS.dependencies,
    COLLECTIONS.areas,
    COLLECTIONS.customTypes,
    COLLECTIONS.notes,
];

const request = async <T,>(
    method: string,
    path: string,
    body?: unknown
): Promise<T | undefined> => {
    const response = await fetch(`${API_BASE}${path}`, {
        method,
        headers:
            body === undefined
                ? undefined
                : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.status === 404) {
        return undefined;
    }

    if (!response.ok) {
        throw new Error(`ChartDB API ${method} ${path} -> ${response.status}`);
    }

    if (response.status === 204) {
        return undefined;
    }

    return (await response.json()) as T;
};

const listCollection = <T,>(
    collection: string,
    diagramId?: string
): Promise<T[]> =>
    request<T[]>(
        'GET',
        `/collections/${collection}${
            diagramId ? `?diagramId=${encodeURIComponent(diagramId)}` : ''
        }`
    ).then((result) => result ?? []);

const getByKey = <T,>(collection: string, key: string): Promise<T | undefined> =>
    request<T>('GET', `/collections/${collection}/${encodeURIComponent(key)}`);

const putByKey = <T,>(collection: string, key: string, item: T): Promise<T> =>
    request<T>('PUT', `/collections/${collection}/${encodeURIComponent(key)}`, item) as Promise<T>;

const patchByKey = <T,>(
    collection: string,
    key: string,
    attributes: Partial<T>
): Promise<T | undefined> =>
    request<T>(
        'PATCH',
        `/collections/${collection}/${encodeURIComponent(key)}`,
        attributes
    );

const deleteByKey = (collection: string, key: string): Promise<unknown> =>
    request('DELETE', `/collections/${collection}/${encodeURIComponent(key)}`);

const deleteCollectionByDiagram = (
    collection: string,
    diagramId: string
): Promise<unknown> =>
    request(
        'DELETE',
        `/collections/${collection}?diagramId=${encodeURIComponent(diagramId)}`
    );

const patchCollectionByDiagram = <T,>(
    collection: string,
    diagramId: string,
    attributes: Partial<T>
): Promise<unknown> =>
    request(
        'PATCH',
        `/collections/${collection}?diagramId=${encodeURIComponent(diagramId)}`,
        attributes
    );

interface BulkPut {
    collection: string;
    key: string;
    item: unknown;
}

interface BulkPayload {
    puts?: BulkPut[];
    deletes?: { collection: string; key: string }[];
    deletesByDiagram?: { collection: string; diagramId: string }[];
}

const bulk = (payload: BulkPayload): Promise<unknown> =>
    request('POST', '/bulk', payload);

const groupByDiagram = <T extends { diagramId?: string }>(
    items: T[]
): Map<string, T[]> => {
    const grouped = new Map<string, T[]>();
    for (const item of items) {
        if (item.diagramId === undefined) {
            continue;
        }
        const bucket = grouped.get(item.diagramId);
        if (bucket) {
            bucket.push(item);
        } else {
            grouped.set(item.diagramId, [item]);
        }
    }
    return grouped;
};

const sortByName = <T extends { name: string }>(items: T[]): T[] =>
    items.sort((a, b) => a.name.localeCompare(b.name));

export const StorageProvider: React.FC<React.PropsWithChildren> = ({
    children,
}) => {
    useEffect(() => {
        let cancelled = false;

        const ensureConfig = async () => {
            const config = await getByKey<ChartDBConfig>(
                COLLECTIONS.config,
                '1'
            );
            if (config || cancelled) {
                return;
            }
            const diagrams = await listCollection<Diagram>(
                COLLECTIONS.diagrams
            );
            if (cancelled) {
                return;
            }
            await putByKey<ChartDBConfig>(COLLECTIONS.config, '1', {
                id: 1,
                defaultDiagramId: diagrams?.[0]?.id ?? '',
            });
        };

        ensureConfig().catch(() => {
            // ignore: config bootstrap is best-effort
        });

        return () => {
            cancelled = true;
        };
    }, []);

    const getConfig: StorageContext['getConfig'] = useCallback(
        async (): Promise<ChartDBConfig | undefined> =>
            await getByKey<ChartDBConfig>(COLLECTIONS.config, '1'),
        []
    );

    const updateConfig: StorageContext['updateConfig'] = useCallback(
        async (config) => {
            await patchByKey<ChartDBConfig>(COLLECTIONS.config, '1', config);
        },
        []
    );

    const getDiagramFilter: StorageContext['getDiagramFilter'] = useCallback(
        async (diagramId): Promise<DiagramFilter | undefined> =>
            await getByKey<DiagramFilter>(
                COLLECTIONS.diagramFilters,
                diagramId
            ),
        []
    );

    const updateDiagramFilter: StorageContext['updateDiagramFilter'] =
        useCallback(async (diagramId, filter): Promise<void> => {
            await putByKey<DiagramFilter>(
                COLLECTIONS.diagramFilters,
                diagramId,
                {
                    diagramId,
                    ...filter,
                }
            );
        }, []);

    const deleteDiagramFilter: StorageContext['deleteDiagramFilter'] =
        useCallback(async (diagramId): Promise<void> => {
            await deleteByKey(COLLECTIONS.diagramFilters, diagramId);
        }, []);

    const addTable: StorageContext['addTable'] = useCallback(
        async ({ diagramId, table }) => {
            await putByKey<DBTable & { diagramId: string }>(
                COLLECTIONS.tables,
                table.id,
                { ...table, diagramId }
            );
        },
        []
    );

    const getTable: StorageContext['getTable'] = useCallback(
        async ({ id, diagramId }): Promise<DBTable | undefined> => {
            const table = await getByKey<DBTable & { diagramId: string }>(
                COLLECTIONS.tables,
                id
            );
            if (!table || (diagramId && table.diagramId !== diagramId)) {
                return undefined;
            }
            return table;
        },
        []
    );

    const deleteDiagramTables: StorageContext['deleteDiagramTables'] =
        useCallback(async (diagramId) => {
            await deleteCollectionByDiagram(COLLECTIONS.tables, diagramId);
        }, []);

    const updateTable: StorageContext['updateTable'] = useCallback(
        async ({ id, attributes }) => {
            await patchByKey<DBTable>(COLLECTIONS.tables, id, attributes);
        },
        []
    );

    const putTable: StorageContext['putTable'] = useCallback(
        async ({ diagramId, table }) => {
            await putByKey<DBTable & { diagramId: string }>(
                COLLECTIONS.tables,
                table.id,
                { ...table, diagramId }
            );
        },
        []
    );

    const deleteTable: StorageContext['deleteTable'] = useCallback(
        async ({ id }) => {
            await deleteByKey(COLLECTIONS.tables, id);
        },
        []
    );

    const listTables: StorageContext['listTables'] = useCallback(
        async (diagramId): Promise<DBTable[]> =>
            await listCollection<DBTable>(COLLECTIONS.tables, diagramId),
        []
    );

    const addRelationship: StorageContext['addRelationship'] = useCallback(
        async ({ diagramId, relationship }) => {
            await putByKey<DBRelationship & { diagramId: string }>(
                COLLECTIONS.relationships,
                relationship.id,
                { ...relationship, diagramId }
            );
        },
        []
    );

    const deleteDiagramRelationships: StorageContext['deleteDiagramRelationships'] =
        useCallback(async (diagramId) => {
            await deleteCollectionByDiagram(
                COLLECTIONS.relationships,
                diagramId
            );
        }, []);

    const getRelationship: StorageContext['getRelationship'] = useCallback(
        async ({ id, diagramId }): Promise<DBRelationship | undefined> => {
            const relationship = await getByKey<
                DBRelationship & { diagramId: string }
            >(COLLECTIONS.relationships, id);
            if (
                !relationship ||
                (diagramId && relationship.diagramId !== diagramId)
            ) {
                return undefined;
            }
            return relationship;
        },
        []
    );

    const updateRelationship: StorageContext['updateRelationship'] =
        useCallback(async ({ id, attributes }) => {
            await patchByKey<DBRelationship>(
                COLLECTIONS.relationships,
                id,
                attributes
            );
        }, []);

    const deleteRelationship: StorageContext['deleteRelationship'] =
        useCallback(async ({ id }) => {
            await deleteByKey(COLLECTIONS.relationships, id);
        }, []);

    const listRelationships: StorageContext['listRelationships'] = useCallback(
        async (diagramId): Promise<DBRelationship[]> =>
            sortByName(
                await listCollection<DBRelationship>(
                    COLLECTIONS.relationships,
                    diagramId
                )
            ),
        []
    );

    const addDependency: StorageContext['addDependency'] = useCallback(
        async ({ diagramId, dependency }) => {
            await putByKey<DBDependency & { diagramId: string }>(
                COLLECTIONS.dependencies,
                dependency.id,
                { ...dependency, diagramId }
            );
        },
        []
    );

    const getDependency: StorageContext['getDependency'] = useCallback(
        async ({ diagramId, id }): Promise<DBDependency | undefined> => {
            const dependency = await getByKey<
                DBDependency & { diagramId: string }
            >(COLLECTIONS.dependencies, id);
            if (!dependency || (diagramId && dependency.diagramId !== diagramId)) {
                return undefined;
            }
            return dependency;
        },
        []
    );

    const updateDependency: StorageContext['updateDependency'] = useCallback(
        async ({ id, attributes }) => {
            await patchByKey<DBDependency>(
                COLLECTIONS.dependencies,
                id,
                attributes
            );
        },
        []
    );

    const deleteDependency: StorageContext['deleteDependency'] = useCallback(
        async ({ id }) => {
            await deleteByKey(COLLECTIONS.dependencies, id);
        },
        []
    );

    const listDependencies: StorageContext['listDependencies'] = useCallback(
        async (diagramId): Promise<DBDependency[]> =>
            await listCollection<DBDependency>(
                COLLECTIONS.dependencies,
                diagramId
            ),
        []
    );

    const deleteDiagramDependencies: StorageContext['deleteDiagramDependencies'] =
        useCallback(async (diagramId) => {
            await deleteCollectionByDiagram(
                COLLECTIONS.dependencies,
                diagramId
            );
        }, []);

    const addArea: StorageContext['addArea'] = useCallback(
        async ({ area, diagramId }) => {
            await putByKey<Area & { diagramId: string }>(
                COLLECTIONS.areas,
                area.id,
                { ...area, diagramId }
            );
        },
        []
    );

    const getArea: StorageContext['getArea'] = useCallback(
        async ({ diagramId, id }): Promise<Area | undefined> => {
            const area = await getByKey<Area & { diagramId: string }>(
                COLLECTIONS.areas,
                id
            );
            if (!area || (diagramId && area.diagramId !== diagramId)) {
                return undefined;
            }
            return area;
        },
        []
    );

    const updateArea: StorageContext['updateArea'] = useCallback(
        async ({ id, attributes }) => {
            await patchByKey<Area>(COLLECTIONS.areas, id, attributes);
        },
        []
    );

    const deleteArea: StorageContext['deleteArea'] = useCallback(
        async ({ id }) => {
            await deleteByKey(COLLECTIONS.areas, id);
        },
        []
    );

    const listAreas: StorageContext['listAreas'] = useCallback(
        async (diagramId): Promise<Area[]> =>
            await listCollection<Area>(COLLECTIONS.areas, diagramId),
        []
    );

    const deleteDiagramAreas: StorageContext['deleteDiagramAreas'] =
        useCallback(async (diagramId) => {
            await deleteCollectionByDiagram(COLLECTIONS.areas, diagramId);
        }, []);

    const addCustomType: StorageContext['addCustomType'] = useCallback(
        async ({ diagramId, customType }) => {
            await putByKey<DBCustomType & { diagramId: string }>(
                COLLECTIONS.customTypes,
                customType.id,
                { ...customType, diagramId }
            );
        },
        []
    );

    const getCustomType: StorageContext['getCustomType'] = useCallback(
        async ({ diagramId, id }): Promise<DBCustomType | undefined> => {
            const customType = await getByKey<
                DBCustomType & { diagramId: string }
            >(COLLECTIONS.customTypes, id);
            if (
                !customType ||
                (diagramId && customType.diagramId !== diagramId)
            ) {
                return undefined;
            }
            return customType;
        },
        []
    );

    const updateCustomType: StorageContext['updateCustomType'] = useCallback(
        async ({ id, attributes }) => {
            await patchByKey<DBCustomType>(
                COLLECTIONS.customTypes,
                id,
                attributes
            );
        },
        []
    );

    const deleteCustomType: StorageContext['deleteCustomType'] = useCallback(
        async ({ id }) => {
            await deleteByKey(COLLECTIONS.customTypes, id);
        },
        []
    );

    const listCustomTypes: StorageContext['listCustomTypes'] = useCallback(
        async (diagramId): Promise<DBCustomType[]> =>
            sortByName(
                await listCollection<DBCustomType>(
                    COLLECTIONS.customTypes,
                    diagramId
                )
            ),
        []
    );

    const deleteDiagramCustomTypes: StorageContext['deleteDiagramCustomTypes'] =
        useCallback(async (diagramId) => {
            await deleteCollectionByDiagram(
                COLLECTIONS.customTypes,
                diagramId
            );
        }, []);

    const addNote: StorageContext['addNote'] = useCallback(
        async ({ note, diagramId }) => {
            await putByKey<Note & { diagramId: string }>(
                COLLECTIONS.notes,
                note.id,
                { ...note, diagramId }
            );
        },
        []
    );

    const getNote: StorageContext['getNote'] = useCallback(
        async ({ diagramId, id }): Promise<Note | undefined> => {
            const note = await getByKey<Note & { diagramId: string }>(
                COLLECTIONS.notes,
                id
            );
            if (!note || (diagramId && note.diagramId !== diagramId)) {
                return undefined;
            }
            return note;
        },
        []
    );

    const updateNote: StorageContext['updateNote'] = useCallback(
        async ({ id, attributes }) => {
            await patchByKey<Note>(COLLECTIONS.notes, id, attributes);
        },
        []
    );

    const deleteNote: StorageContext['deleteNote'] = useCallback(
        async ({ id }) => {
            await deleteByKey(COLLECTIONS.notes, id);
        },
        []
    );

    const listNotes: StorageContext['listNotes'] = useCallback(
        async (diagramId): Promise<Note[]> =>
            await listCollection<Note>(COLLECTIONS.notes, diagramId),
        []
    );

    const deleteDiagramNotes: StorageContext['deleteDiagramNotes'] =
        useCallback(async (diagramId) => {
            await deleteCollectionByDiagram(COLLECTIONS.notes, diagramId);
        }, []);

    const addDiagram: StorageContext['addDiagram'] = useCallback(
        async ({ diagram }) => {
            const puts: BulkPut[] = [
                {
                    collection: COLLECTIONS.diagrams,
                    key: diagram.id,
                    item: {
                        id: diagram.id,
                        name: diagram.name,
                        databaseType: diagram.databaseType,
                        databaseEdition: diagram.databaseEdition,
                        createdAt: diagram.createdAt,
                        updatedAt: diagram.updatedAt,
                    },
                },
            ];

            for (const table of diagram.tables ?? []) {
                puts.push({
                    collection: COLLECTIONS.tables,
                    key: table.id,
                    item: { ...table, diagramId: diagram.id },
                });
            }
            for (const relationship of diagram.relationships ?? []) {
                puts.push({
                    collection: COLLECTIONS.relationships,
                    key: relationship.id,
                    item: { ...relationship, diagramId: diagram.id },
                });
            }
            for (const dependency of diagram.dependencies ?? []) {
                puts.push({
                    collection: COLLECTIONS.dependencies,
                    key: dependency.id,
                    item: { ...dependency, diagramId: diagram.id },
                });
            }
            for (const area of diagram.areas ?? []) {
                puts.push({
                    collection: COLLECTIONS.areas,
                    key: area.id,
                    item: { ...area, diagramId: diagram.id },
                });
            }
            for (const customType of diagram.customTypes ?? []) {
                puts.push({
                    collection: COLLECTIONS.customTypes,
                    key: customType.id,
                    item: { ...customType, diagramId: diagram.id },
                });
            }
            for (const note of diagram.notes ?? []) {
                puts.push({
                    collection: COLLECTIONS.notes,
                    key: note.id,
                    item: { ...note, diagramId: diagram.id },
                });
            }

            await bulk({ puts });
        },
        []
    );

    const listDiagrams: StorageContext['listDiagrams'] = useCallback(
        async (options = {}): Promise<Diagram[]> => {
            const diagrams = await listCollection<Diagram>(
                COLLECTIONS.diagrams
            );

            if (options.includeTables) {
                const grouped = groupByDiagram(
                    await listCollection<DBTable>(COLLECTIONS.tables)
                );
                diagrams.forEach((d) => (d.tables = grouped.get(d.id) ?? []));
            }
            if (options.includeRelationships) {
                const grouped = groupByDiagram(
                    await listCollection<DBRelationship>(
                        COLLECTIONS.relationships
                    )
                );
                grouped.forEach((items) => sortByName(items));
                diagrams.forEach(
                    (d) => (d.relationships = grouped.get(d.id) ?? [])
                );
            }
            if (options.includeDependencies) {
                const grouped = groupByDiagram(
                    await listCollection<DBDependency>(
                        COLLECTIONS.dependencies
                    )
                );
                diagrams.forEach(
                    (d) => (d.dependencies = grouped.get(d.id) ?? [])
                );
            }
            if (options.includeAreas) {
                const grouped = groupByDiagram(
                    await listCollection<Area>(COLLECTIONS.areas)
                );
                diagrams.forEach((d) => (d.areas = grouped.get(d.id) ?? []));
            }
            if (options.includeCustomTypes) {
                const grouped = groupByDiagram(
                    await listCollection<DBCustomType>(
                        COLLECTIONS.customTypes
                    )
                );
                grouped.forEach((items) => sortByName(items));
                diagrams.forEach(
                    (d) => (d.customTypes = grouped.get(d.id) ?? [])
                );
            }
            if (options.includeNotes) {
                const grouped = groupByDiagram(
                    await listCollection<Note>(COLLECTIONS.notes)
                );
                diagrams.forEach((d) => (d.notes = grouped.get(d.id) ?? []));
            }

            return diagrams;
        },
        []
    );

    const getDiagram: StorageContext['getDiagram'] = useCallback(
        async (id, options = {}): Promise<Diagram | undefined> => {
            const diagram = await getByKey<Diagram>(
                COLLECTIONS.diagrams,
                id
            );
            if (!diagram) {
                return undefined;
            }

            if (options.includeTables) {
                diagram.tables = await listCollection<DBTable>(
                    COLLECTIONS.tables,
                    id
                );
            }
            if (options.includeRelationships) {
                diagram.relationships = sortByName(
                    await listCollection<DBRelationship>(
                        COLLECTIONS.relationships,
                        id
                    )
                );
            }
            if (options.includeDependencies) {
                diagram.dependencies = await listCollection<DBDependency>(
                    COLLECTIONS.dependencies,
                    id
                );
            }
            if (options.includeAreas) {
                diagram.areas = await listCollection<Area>(
                    COLLECTIONS.areas,
                    id
                );
            }
            if (options.includeCustomTypes) {
                diagram.customTypes = sortByName(
                    await listCollection<DBCustomType>(
                        COLLECTIONS.customTypes,
                        id
                    )
                );
            }
            if (options.includeNotes) {
                diagram.notes = await listCollection<Note>(
                    COLLECTIONS.notes,
                    id
                );
            }

            return diagram;
        },
        []
    );

    const updateDiagram: StorageContext['updateDiagram'] = useCallback(
        async ({ id, attributes }) => {
            await patchByKey<Diagram>(COLLECTIONS.diagrams, id, attributes);

            if (attributes.id) {
                await Promise.all(
                    DIAGRAM_SCOPED_COLLECTIONS.map((collection) =>
                        patchCollectionByDiagram(collection, id, {
                            diagramId: attributes.id,
                        })
                    )
                );
            }
        },
        []
    );

    const deleteDiagram: StorageContext['deleteDiagram'] = useCallback(
        async (id) => {
            await bulk({
                deletes: [{ collection: COLLECTIONS.diagrams, key: id }],
                deletesByDiagram: DIAGRAM_SCOPED_COLLECTIONS.map(
                    (collection) => ({ collection, diagramId: id })
                ),
            });
        },
        []
    );

    return (
        <storageContext.Provider
            value={{
                getConfig,
                updateConfig,
                addDiagram,
                listDiagrams,
                getDiagram,
                updateDiagram,
                deleteDiagram,
                addTable,
                getTable,
                updateTable,
                putTable,
                deleteTable,
                listTables,
                addRelationship,
                getRelationship,
                updateRelationship,
                deleteRelationship,
                listRelationships,
                deleteDiagramTables,
                deleteDiagramRelationships,
                addDependency,
                getDependency,
                updateDependency,
                deleteDependency,
                listDependencies,
                deleteDiagramDependencies,
                addArea,
                getArea,
                updateArea,
                deleteArea,
                listAreas,
                deleteDiagramAreas,
                addCustomType,
                getCustomType,
                updateCustomType,
                deleteCustomType,
                listCustomTypes,
                deleteDiagramCustomTypes,
                addNote,
                getNote,
                updateNote,
                deleteNote,
                listNotes,
                deleteDiagramNotes,
                getDiagramFilter,
                updateDiagramFilter,
                deleteDiagramFilter,
            }}
        >
            {children}
        </storageContext.Provider>
    );
};
