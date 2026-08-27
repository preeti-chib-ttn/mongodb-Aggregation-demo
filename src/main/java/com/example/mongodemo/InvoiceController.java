package com.example.mongodemo;

import org.bson.Document;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.aggregation.Aggregation;
import org.springframework.data.mongodb.core.aggregation.AggregationResults;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class InvoiceController {

    private static final String COLLECTION = "invoices";

    private final MongoTemplate mongoTemplate;

    public InvoiceController(MongoTemplate mongoTemplate) {
        this.mongoTemplate = mongoTemplate;
    }

    @GetMapping("/bad")
    public String bad(@RequestParam(defaultValue = "100000") int limit) {
        AggregationResults<Document> results = mongoTemplate.aggregate(
                readyInvoicesPipeline(limit), COLLECTION, Document.class);
        return "Materialized " + results.getMappedResults().size() + " documents in JVM heap";
    }

    @GetMapping("/good")
    public String good(@RequestParam(defaultValue = "100000") int limit) {
        Aggregation pipeline = readyInvoicesPipeline(limit);
        long count = 0;
        try (var cursor = mongoTemplate.getCollection(COLLECTION)
                .aggregate(pipeline.toPipeline(Aggregation.DEFAULT_CONTEXT))
                .batchSize(500)
                .iterator()) {
            while (cursor.hasNext()) {
                cursor.next();
                count++;
            }
        }
        return "Streamed " + count + " documents without accumulating them";
    }

    private static Aggregation readyInvoicesPipeline(int limit) {
        return Aggregation.newAggregation(
                Aggregation.match(Criteria.where("status").is("READY")),
                Aggregation.limit(limit)
        );
    }
}
