package com.example.mongodemo;

import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.aggregation.Aggregation;
import org.springframework.data.mongodb.core.aggregation.AggregationOptions;
import org.springframework.data.mongodb.core.query.Criteria;

import java.time.Duration;

/**
 * Shared top-K rollup used by the aggregation-options demo.
 * Console equivalent: {@code scripts/aggregation-options.mongosh.js}
 */
final class InvoiceAnalyticsPipeline {

    static final String COLLECTION = "invoices";
    static final String DEMO_COMMENT = "demo/invoice-analytics-by-region/v1";
    static final Duration DEMO_MAX_TIME = Duration.ofSeconds(30);

    private InvoiceAnalyticsPipeline() {
    }

    static Aggregation topRegionsByReadyCount(String orgId, int limit) {
        return Aggregation.newAggregation(
                Aggregation.match(
                        Criteria.where("orgId").is(orgId).and("status").is("READY")),
                Aggregation.group("region").count().as("count"),
                Aggregation.sort(Sort.Direction.DESC, "count"),
                Aggregation.limit(limit)
        );
    }

    static AggregationOptions productionOptions() {
        return AggregationOptions.builder()
                .allowDiskUse(true)
                .comment(DEMO_COMMENT)
                .maxTime(DEMO_MAX_TIME)
                .build();
    }

    static AggregationOptions aggressiveTimeoutOptions() {
        return AggregationOptions.builder()
                .comment(DEMO_COMMENT + "/maxtime-intent")
                .maxTime(Duration.ofMillis(1))
                .build();
    }
}
