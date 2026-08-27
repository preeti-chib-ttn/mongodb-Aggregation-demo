package com.example.mongodemo;

import com.mongodb.MongoExecutionTimeoutException;
import org.bson.Document;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.aggregation.Aggregation;
import org.springframework.data.mongodb.core.aggregation.AggregationOptions;
import org.springframework.data.mongodb.core.aggregation.AggregationResults;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Duration;
import java.util.Optional;

/**
 * Demonstrates the Spring Data {@code withOptions()} immutability trap.
 */
@RestController
public class AggregationOptionsController {

    private final MongoTemplate mongoTemplate;

    public AggregationOptionsController(MongoTemplate mongoTemplate) {
        this.mongoTemplate = mongoTemplate;
    }

    @GetMapping("/options/broken")
    public String broken(
            @RequestParam(defaultValue = "org-alpha") String orgId,
            @RequestParam(defaultValue = "10") int limit) {
        Aggregation pipeline = InvoiceAnalyticsPipeline.topRegionsByReadyCount(orgId, limit);
        AggregationOptions intended = InvoiceAnalyticsPipeline.productionOptions();

        pipeline.withOptions(intended);

        return formatDemo(
                1,
                "The withOptions() Trap — BROKEN",
                """
                Spring Data Aggregation is IMMUTABLE.
                Calling pipeline.withOptions(options) without using the return value
                is a silent no-op. MongoDB never receives your options.
                """,
                """
                // WRONG — return value discarded
                Aggregation pipeline = Aggregation.newAggregation(match, group, sort, limit);
                pipeline.withOptions(AggregationOptions.builder()
                    .allowDiskUse(true)
                    .comment("demo/...")
                    .maxTime(Duration.ofSeconds(30))
                    .build());
                mongoTemplate.aggregate(pipeline, "invoices", Document.class);
                """,
                intended,
                pipeline.getOptions(),
                runQuery(pipeline),
                """
                Chain or assign the new instance:
                  pipeline = pipeline.withOptions(options);
                or build in one expression:
                  Aggregation.newAggregation(ops).withOptions(options);
                """
        );
    }

    @GetMapping("/options/fixed")
    public String fixed(
            @RequestParam(defaultValue = "org-alpha") String orgId,
            @RequestParam(defaultValue = "10") int limit) {
        AggregationOptions options = InvoiceAnalyticsPipeline.productionOptions();
        Aggregation pipeline = InvoiceAnalyticsPipeline.topRegionsByReadyCount(orgId, limit)
                .withOptions(options);

        return formatDemo(
                2,
                "The withOptions() Trap — FIXED",
                """
                Execution options (allowDiskUse, maxTime, comment) are NOT pipeline stages.
                They must live on the Aggregation object passed to aggregate().
                Chaining .withOptions() attaches them correctly.
                """,
                """
                // CORRECT — chain withOptions() on the pipeline
                Aggregation pipeline = Aggregation.newAggregation(match, group, sort, limit)
                    .withOptions(AggregationOptions.builder()
                        .allowDiskUse(true)
                        .comment("demo/invoice-analytics-by-region/v1")
                        .maxTime(Duration.ofSeconds(30))
                        .build());
                mongoTemplate.aggregate(pipeline, "invoices", Document.class);
                """,
                options,
                pipeline.getOptions(),
                runQuery(pipeline),
                """
                In production, always set comment (for currentOp/profiler) and maxTime
                (so pathological queries release the request thread).
                Use allowDiskUse only when explain shows usedDisk on blocking stages.
                """
        );
    }

    @GetMapping("/options/maxtime-trap")
    public String maxTimeTrap(
            @RequestParam(defaultValue = "org-alpha") String orgId,
            @RequestParam(defaultValue = "10") int limit) {
        Aggregation pipeline = InvoiceAnalyticsPipeline.topRegionsByReadyCount(orgId, limit);
        AggregationOptions intended = InvoiceAnalyticsPipeline.aggressiveTimeoutOptions();

        pipeline.withOptions(intended);

        QueryOutcome outcome = runQuery(pipeline);
        String resultNote = outcome.completed()
                ? "Query COMPLETED — but developer intended maxTime=1ms (would fail if sent)."
                : "Query TIMED OUT — maxTime was on the wire.";

        return formatDemo(
                3,
                "maxTime Discarded — Silent Failure",
                """
                Developer set maxTime=1ms to bound query duration.
                Because withOptions() was discarded, the server ran with no time limit.
                The query succeeds when it should have been aborted immediately.
                """,
                """
                // WRONG — 1ms maxTime never reaches MongoDB
                pipeline.withOptions(AggregationOptions.builder()
                    .maxTime(Duration.ofMillis(1))
                    .build());
                mongoTemplate.aggregate(pipeline, "invoices", Document.class);
                // Query completes — maxTime was never applied
                """,
                intended,
                pipeline.getOptions(),
                outcome,
                resultNote + """

                Compare: in mongosh, aggregate(pipeline, { maxTimeMS: 1 }) fails instantly.
                That proves maxTime works when sent — Spring just never sent it here.
                """
        );
    }

    @GetMapping("/options/raw-driver-trap")
    public String rawDriverTrap(
            @RequestParam(defaultValue = "org-alpha") String orgId,
            @RequestParam(defaultValue = "10") int limit) {
        AggregationOptions options = InvoiceAnalyticsPipeline.productionOptions();
        Aggregation pipeline = InvoiceAnalyticsPipeline.topRegionsByReadyCount(orgId, limit)
                .withOptions(options);

        long count;
        try (var cursor = mongoTemplate.getCollection(InvoiceAnalyticsPipeline.COLLECTION)
                .aggregate(pipeline.toPipeline(Aggregation.DEFAULT_CONTEXT))
                .iterator()) {
            count = 0;
            while (cursor.hasNext()) {
                cursor.next();
                count++;
            }
        }

        return formatDemo(
                4,
                "toPipeline() Drops Execution Options",
                """
                A second trap: toPipeline() extracts STAGE documents only.
                allowDiskUse, maxTime, and comment are execution options — not stages.
                Options on the Spring Aggregation object are ignored by the raw driver path.
                """,
                """
                // WRONG — options on Spring object, but raw driver only gets stages
                Aggregation pipeline = Aggregation.newAggregation(ops).withOptions(options);
                collection.aggregate(pipeline.toPipeline(context)).iterator();

                // CORRECT — set options on AggregateIterable
                collection.aggregate(pipeline.toPipeline(context))
                    .allowDiskUse(true)
                    .maxTime(30, TimeUnit.SECONDS)
                    .comment("demo/...")
                    .iterator();
                """,
                options,
                optionsFromRawDriverPath(),
                new QueryOutcome(count + " region groups returned via raw driver", true, (int) count),
                """
                Spring object has options: """ + describeOptions(options) + """
                
                Raw driver path sent:     """ + describeOptions(optionsFromRawDriverPath()) + """
                
                Only the driver-level .allowDiskUse() / .maxTime() / .comment() calls matter
                when you bypass mongoTemplate.aggregate().
                """
        );
    }

    /** Raw driver path does not inherit Spring AggregationOptions. */
    private static AggregationOptions optionsFromRawDriverPath() {
        return AggregationOptions.builder().build();
    }

    private QueryOutcome runQuery(Aggregation pipeline) {
        try {
            AggregationResults<Document> results = mongoTemplate.aggregate(
                    pipeline, InvoiceAnalyticsPipeline.COLLECTION, Document.class);
            int count = results.getMappedResults().size();
            return new QueryOutcome("completed — " + count + " region groups returned", true, count);
        } catch (MongoExecutionTimeoutException ex) {
            return new QueryOutcome("MongoExecutionTimeoutException — maxTime reached", false, 0);
        }
    }

    private static String formatDemo(
            int number,
            String title,
            String lesson,
            String code,
            AggregationOptions intended,
            AggregationOptions actual,
            QueryOutcome outcome,
            String takeaway) {
        return """
                %s
                 DEMO %d of 4 — %s
                %s

                LESSON
                %s

                CODE
                %s

                OPTIONS COMPARISON
                %s

                RESULT
                  %s

                TAKEAWAY
                %s
                """.formatted(
                rule(),
                number,
                title,
                rule(),
                indent(lesson.strip()),
                indent(code.strip()),
                formatOptionsTable(intended, actual),
                outcome.message(),
                indent(takeaway.strip())
        );
    }

    private static String formatOptionsTable(AggregationOptions intended, AggregationOptions actual) {
        return """
                  Option          Intended (developer)    Actually on pipeline
                  ──────────────  ────────────────────  ────────────────────
                  allowDiskUse    %-20s  %-20s
                  comment         %-20s  %-20s
                  maxTime         %-20s  %-20s
                """.formatted(
                formatBool(intended.isAllowDiskUse()),
                formatBool(actual.isAllowDiskUse()),
                formatComment(intended.getComment()),
                formatComment(actual.getComment()),
                formatMaxTime(intended.getMaxTime()),
                formatMaxTime(actual.getMaxTime())
        );
    }

    private static String rule() {
        return "═".repeat(62);
    }

    private static String indent(String text) {
        return text.lines().map(line -> "  " + line).reduce((a, b) -> a + "\n" + b).orElse("");
    }

    private static String formatBool(boolean value) {
        return value ? "true" : "false";
    }

    private static String formatMaxTime(Duration maxTime) {
        if (maxTime == null || maxTime.isZero()) {
            return "(none)";
        }
        return maxTime.toMillis() + "ms";
    }

    private static String formatComment(Optional<String> comment) {
        return comment.orElse("(none)");
    }

    private static String describeOptions(AggregationOptions options) {
        return "allowDiskUse=%s, comment=%s, maxTime=%s".formatted(
                formatBool(options.isAllowDiskUse()),
                formatComment(options.getComment()),
                formatMaxTime(options.getMaxTime()));
    }

    private record QueryOutcome(String message, boolean completed, int resultCount) {
    }
}
